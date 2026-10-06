import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  connect,
  constants,
  type ClientHttp2Session,
  type IncomingHttpHeaders,
  type OutgoingHttpHeaders,
} from "node:http2";

import type { ApnsEnvironment, PushApp } from "@sikemux/protocol";

import type { Delivery, PushMessage, PushProvider } from "./provider.ts";

/** The token-signing key Apple hands out as a .p8 file, and who it belongs to. */
export interface ApnsKey {
  keyId: string;
  teamId: string;
  privateKey: KeyObject;
}

/** Each build of the phone app is its own topic: the bundle id it was signed as. */
export const APNS_TOPICS: Record<PushApp, string> = {
  production: "com.nodelike.sikemux.mobile",
  dev: "com.nodelike.sikemux.mobile.dev",
};

const ENDPOINTS: Record<ApnsEnvironment, string> = {
  production: "https://api.push.apple.com",
  sandbox: "https://api.sandbox.push.apple.com",
};

/** Apple refuses a provider token older than an hour, and one replaced more often than every 20 minutes. */
const TOKEN_LIFE_MS = 50 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

/** The card a phone shows when its notification extension cannot open what the host sealed. */
export const GENERIC_ALERT = {
  title: "Sikemux",
  body: "An agent on your computer needs you",
};

/** Reads a .p8 key file, throwing a message that names what is wrong with it. */
export function readApnsKey(path: string): KeyObject {
  let pem: string;
  try {
    pem = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(
      `cannot be read (${(error as NodeJS.ErrnoException).code ?? "unknown error"})`,
      { cause: error },
    );
  }
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch {
    throw new Error("is not a PEM private key");
  }
  if (
    key.asymmetricKeyType !== "ec" ||
    key.asymmetricKeyDetails?.namedCurve !== "prime256v1"
  )
    throw new Error("is not a P-256 key, as Apple's .p8 keys are");
  return key;
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

/** The ES256 provider token Apple checks on every request. */
export function signProviderToken(key: ApnsKey, nowMs: number): string {
  const header = { alg: "ES256", kid: key.keyId };
  const claims = { iss: key.teamId, iat: Math.floor(nowMs / 1000) };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signature = sign("sha256", Buffer.from(unsigned), {
    key: key.privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${unsigned}.${base64url(signature)}`;
}

export interface ApnsReply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

/** Sends one request over HTTP/2, the only protocol APNs speaks. */
export type ApnsTransport = (
  origin: string,
  headers: OutgoingHttpHeaders,
  body: string,
) => Promise<ApnsReply>;

/** Keeps one HTTP/2 connection to each origin, as Apple asks, and opens a new one when it closes. */
export class Http2Transport {
  private readonly sessions = new Map<string, ClientHttp2Session>();

  readonly send: ApnsTransport = (origin, headers, body) =>
    new Promise((resolve, reject) => {
      const session = this.session(origin);
      const stream = session.request(headers);
      stream.setTimeout(REQUEST_TIMEOUT_MS, () =>
        stream.close(constants.NGHTTP2_CANCEL),
      );
      let replied: IncomingHttpHeaders = {};
      const chunks: Buffer[] = [];
      stream.on("response", (headers) => {
        replied = headers;
      });
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () =>
        resolve({
          status: Number(replied[":status"] ?? 0),
          headers: replied,
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
      stream.on("close", () => {
        if (stream.rstCode !== constants.NGHTTP2_NO_ERROR)
          reject(new Error(`the stream was reset (${stream.rstCode})`));
      });
      stream.on("error", reject);
      stream.end(body);
    });

  close() {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
  }

  private session(origin: string): ClientHttp2Session {
    const open = this.sessions.get(origin);
    if (open && !open.closed && !open.destroyed) return open;
    const session = connect(origin);
    const forget = () => {
      if (this.sessions.get(origin) === session) this.sessions.delete(origin);
    };
    session.on("close", forget);
    session.on("goaway", forget);
    session.on("error", forget);
    session.unref();
    this.sessions.set(origin, session);
    return session;
  }
}

export interface ApnsOptions {
  topic: string;
  /** Where each of Apple's push servers is; tests point them at a fake. */
  endpoints?: Record<ApnsEnvironment, string>;
  transport?: ApnsTransport;
  now?: () => number;
}

/** Retry-After from APNs, in seconds, as milliseconds. */
function retryAfter(headers: IncomingHttpHeaders): number | undefined {
  const header = headers["retry-after"];
  const seconds = typeof header === "string" ? Number(header) : NaN;
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

function reasonOf(reply: ApnsReply): string {
  try {
    const parsed = JSON.parse(reply.body) as { reason?: unknown };
    if (typeof parsed.reason === "string") return parsed.reason;
  } catch {
    // An empty or unreadable body leaves the status to say what went wrong.
  }
  return String(reply.status);
}

/** Tokens Apple will never deliver to again, or that belong to another app. */
const DEAD = new Set([
  "BadDeviceToken",
  "Unregistered",
  "DeviceTokenNotForTopic",
]);

/**
 * Sends to iPhones through APNs with a token-based key. An alert reaches the phone's notification
 * extension, which opens the sealed card and shows it; a clear wakes the app in the background to
 * take a card away.
 */
export class ApnsProvider implements PushProvider {
  private readonly key: ApnsKey;
  private readonly topic: string;
  private readonly endpoints: Record<ApnsEnvironment, string>;
  private readonly transport: ApnsTransport;
  private readonly http2: Http2Transport | null;
  private readonly now: () => number;
  private providerToken: { value: string; refreshAt: number } | null = null;

  constructor(key: ApnsKey, options: ApnsOptions) {
    this.key = key;
    this.topic = options.topic;
    this.endpoints = options.endpoints ?? ENDPOINTS;
    if (options.transport) {
      this.http2 = null;
      this.transport = options.transport;
    } else {
      this.http2 = new Http2Transport();
      this.transport = this.http2.send;
    }
    this.now = options.now ?? Date.now;
  }

  async send(message: PushMessage): Promise<Delivery> {
    let reply = await this.post(message);
    if (reply instanceof Error)
      return { outcome: "retry", reason: reply.message };
    if (reply.status === 403 && reasonOf(reply) === "ExpiredProviderToken") {
      this.providerToken = null;
      reply = await this.post(message);
      if (reply instanceof Error)
        return { outcome: "retry", reason: reply.message };
    }
    if (reply.status === 200) return { outcome: "sent" };
    const reason = reasonOf(reply);
    if (reply.status === 410 || DEAD.has(reason))
      return { outcome: "dead", reason };
    if (reply.status === 429 || reply.status >= 500) {
      const afterMs = retryAfter(reply.headers);
      return {
        outcome: "retry",
        reason,
        ...(afterMs === undefined ? {} : { afterMs }),
      };
    }
    return { outcome: "failed", reason: `${reply.status} ${reason}` };
  }

  close() {
    this.http2?.close();
  }

  private async post(message: PushMessage): Promise<ApnsReply | Error> {
    const alert = message.kind === "alert";
    const ttl = Math.ceil(message.ttlSeconds);
    const headers: OutgoingHttpHeaders = {
      ":method": "POST",
      ":path": `/3/device/${encodeURIComponent(message.token)}`,
      authorization: `bearer ${this.token()}`,
      "apns-topic": this.topic,
      "apns-push-type": alert ? "alert" : "background",
      "apns-priority": alert ? "10" : "5",
      "apns-expiration": String(
        ttl > 0 ? Math.floor(this.now() / 1000) + ttl : 0,
      ),
      "content-type": "application/json",
      ...(alert ? { "apns-collapse-id": message.collapseId } : {}),
    };
    const aps = alert
      ? { alert: GENERIC_ALERT, sound: "default", "mutable-content": 1 }
      : { "content-available": 1 };
    const body = JSON.stringify({
      aps,
      b: message.blob,
      c: message.collapseId,
      t: message.kind,
    });
    try {
      return await this.transport(
        this.endpoints[message.apnsEnvironment ?? "production"],
        headers,
        body,
      );
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  }

  private token(): string {
    const now = this.now();
    if (this.providerToken && now < this.providerToken.refreshAt)
      return this.providerToken.value;
    const value = signProviderToken(this.key, now);
    this.providerToken = { value, refreshAt: now + TOKEN_LIFE_MS };
    return value;
  }
}

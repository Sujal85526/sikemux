import { execFileSync } from "node:child_process";
import { createHash, randomUUID, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ASSET_URL = "https://updates.sikemux.com/assets/";

/** A throwaway signing key and certificate, made fresh so tests never touch the real one. */
export function signingKey(): { key: string; certificate: string } {
  const dir = mkdtempSync(join(tmpdir(), "sikemux-update-key-"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-subj",
      "/CN=Sikemux test updates",
      "-days",
      "2",
      "-keyout",
      join(dir, "key.pem"),
      "-out",
      join(dir, "cert.pem"),
    ],
    { stdio: "ignore" },
  );
  return {
    key: readFileSync(join(dir, "key.pem"), "utf8"),
    certificate: readFileSync(join(dir, "cert.pem"), "utf8"),
  };
}

export interface BundleOptions {
  key: string;
  id?: string;
  createdAt?: string;
  platform?: string;
  runtimeVersion?: string;
  channel?: string;
  assets?: { bytes: string; contentType: string; fileExtension: string }[];
}

export interface Bundle {
  dir: string;
  id: string;
  manifest: Buffer;
  signature: string;
  hexes: string[];
}

/** Writes an unpacked publish bundle the way CI does, signed with `key`. */
export function writeBundle(options: BundleOptions): Bundle {
  const id = options.id ?? randomUUID();
  const createdAt = options.createdAt ?? new Date().toISOString();
  const runtimeVersion = options.runtimeVersion ?? "runtime-1";
  const channel = options.channel ?? "nightly";
  const commit = "a".repeat(40);
  const message = "feat(mobile): a test update";
  const dir = mkdtempSync(join(tmpdir(), "sikemux-update-bundle-"));
  mkdirSync(join(dir, "assets"));

  const files = [
    {
      bytes: `globalThis.update = ${JSON.stringify(id)};`,
      contentType: "application/javascript",
      fileExtension: ".bundle",
    },
    ...(options.assets ?? [
      { bytes: "<svg/>", contentType: "image/svg+xml", fileExtension: ".svg" },
    ]),
  ];
  const entries = files.map(({ bytes, contentType, fileExtension }) => {
    const hash = createHash("sha256").update(bytes);
    const hex = hash.copy().digest("hex");
    writeFileSync(join(dir, "assets", hex), bytes);
    writeFileSync(join(dir, "assets", `${hex}.type`), `${contentType}\n`);
    return {
      hex,
      asset: {
        hash: hash.digest("base64url"),
        key: createHash("md5").update(bytes).digest("hex"),
        contentType,
        fileExtension,
        url: `${ASSET_URL}${hex}`,
      },
    };
  });
  const [launch, ...rest] = entries;
  const manifest = Buffer.from(
    JSON.stringify({
      id,
      createdAt,
      runtimeVersion,
      launchAsset: launch?.asset,
      assets: rest.map((entry) => entry.asset),
      metadata: {},
      extra: { commit, message, channel },
    }),
  );
  const signature = sign("sha256", manifest, options.key).toString("base64");
  writeFileSync(join(dir, "manifest.json"), manifest);
  writeFileSync(join(dir, "manifest.sig"), signature);
  writeFileSync(
    join(dir, "update.json"),
    `${JSON.stringify({
      id,
      createdAt,
      platform: options.platform ?? "android",
      runtimeVersion,
      channel,
      commit,
      message,
    })}\n`,
  );
  return {
    dir,
    id,
    manifest,
    signature,
    hexes: entries.map((entry) => entry.hex),
  };
}

export interface Part {
  headers: Record<string, string>;
  body: Buffer;
}

/** Reads a multipart/mixed body the way Expo's client does: parts between boundary lines. */
export function readMultipart(contentType: string, body: Buffer): Part[] {
  const boundary = /boundary=([^;]+)/.exec(contentType)?.[1];
  if (!boundary) throw new Error(`no boundary in ${contentType}`);
  const delimiter = Buffer.from(`--${boundary}`);
  const parts: Part[] = [];
  let at = body.indexOf(delimiter);
  if (at !== 0) throw new Error("the body does not start with a boundary");
  for (;;) {
    at += delimiter.length;
    if (body.subarray(at, at + 2).toString() === "--") break;
    if (body.subarray(at, at + 2).toString() !== "\r\n")
      throw new Error("a boundary is not followed by a line break");
    at += 2;
    const headerEnd = body.indexOf("\r\n\r\n", at);
    const headers = Object.fromEntries(
      body
        .subarray(at, headerEnd)
        .toString()
        .split("\r\n")
        .map((line) => {
          const colon = line.indexOf(":");
          return [
            line.slice(0, colon).trim().toLowerCase(),
            line.slice(colon + 1).trim(),
          ];
        }),
    );
    const next = body.indexOf(`\r\n--${boundary}`, headerEnd + 4);
    if (next < 0) throw new Error("a part never ends");
    parts.push({ headers, body: body.subarray(headerEnd + 4, next) });
    at = next + 2;
  }
  return parts;
}

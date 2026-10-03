import type { Network } from "@sikemux/protocol";
import type { Level } from "pino";

import { readNetwork } from "./network/network.ts";
import { readPush, type PushSettings } from "./push/settings.ts";

export interface MigrationConfig {
  databaseUrl: string;
  logLevel: Level;
}

export interface Config extends MigrationConfig {
  host: string;
  port: number;
  /** The web app's origin, the only page allowed to call the API from a browser. */
  appOrigin: string;
  /** The Clerk instance whose sign-ins the API accepts, such as https://clerk.sikemux.com. */
  clerkIssuer: string;
  /** The Mac app's Clerk OAuth client, the only one whose access tokens are accepted. */
  macClientId: string;
  /** For Clerk's Backend API. Without it, deleting accounts and revoking removed phones' sessions wait in the database. */
  clerkSecretKey: string | null;
  /** Checks the signatures on Clerk's webhooks. Without it, the webhook route refuses everything. */
  clerkWebhookSecret: string | null;
  /** What GET /v1/network answers: the relay apps use and the oldest app versions allowed. */
  network: Network;
  push: PushSettings;
}

const LEVELS: readonly Level[] = [
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
];

/** Collects every problem with the environment, so one failed start names them all. */
function reader(env: NodeJS.ProcessEnv) {
  const problems: string[] = [];
  const read = (name: string, fallback?: string) => {
    const value = env[name]?.trim() || fallback;
    if (value === undefined) problems.push(`${name} is not set`);
    return value ?? "";
  };
  const readDatabaseUrl = () => {
    const databaseUrl = read("DATABASE_URL");
    if (databaseUrl && !/^postgres(ql)?:\/\//.test(databaseUrl))
      problems.push("DATABASE_URL is not a postgres:// URL");
    return databaseUrl;
  };
  const readLogLevel = () => {
    const logLevel = read("LOG_LEVEL", "info") as Level;
    if (!LEVELS.includes(logLevel))
      problems.push(`LOG_LEVEL is not one of ${LEVELS.join(", ")}`);
    return logLevel;
  };
  const finish = <T>(config: T): T => {
    if (problems.length)
      throw new Error(`The API cannot start: ${problems.join("; ")}.`);
    return config;
  };
  return { problems, read, readDatabaseUrl, readLogLevel, finish };
}

/** Reads only what migrating needs, so a deploy can migrate without the server's settings. */
export function loadMigrationConfig(env: NodeJS.ProcessEnv): MigrationConfig {
  const { readDatabaseUrl, readLogLevel, finish } = reader(env);
  return finish({ databaseUrl: readDatabaseUrl(), logLevel: readLogLevel() });
}

/** Reads the configuration from the environment, refusing to start on anything missing or malformed. */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const { problems, read, readDatabaseUrl, readLogLevel, finish } = reader(env);

  const databaseUrl = readDatabaseUrl();

  const port = Number(read("PORT", "4000"));
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    problems.push("PORT is not a port number");

  const appOrigin = read("APP_ORIGIN", "https://app.sikemux.com");
  if (appOrigin && URL.parse(appOrigin)?.origin !== appOrigin)
    problems.push("APP_ORIGIN is not an origin like https://app.sikemux.com");

  const clerkIssuer = read("CLERK_ISSUER");
  if (
    clerkIssuer &&
    (URL.parse(clerkIssuer)?.origin !== clerkIssuer ||
      !clerkIssuer.startsWith("https://"))
  )
    problems.push(
      "CLERK_ISSUER is not an https origin like https://clerk.sikemux.com",
    );

  const macClientId = read("CLERK_MAC_CLIENT_ID");

  const clerkSecretKey = env.CLERK_SECRET_KEY?.trim() || null;
  if (clerkSecretKey && !/^sk_(live|test)_\S+$/.test(clerkSecretKey))
    problems.push("CLERK_SECRET_KEY is not a secret key like sk_live_…");

  const clerkWebhookSecret = env.CLERK_WEBHOOK_SECRET?.trim() || null;
  if (clerkWebhookSecret && !/^whsec_[A-Za-z0-9+/=]+$/.test(clerkWebhookSecret))
    problems.push("CLERK_WEBHOOK_SECRET is not a signing secret like whsec_…");

  const network = readNetwork(env, problems);
  const push = readPush(env, problems);
  const logLevel = readLogLevel();
  const host = read("HOST", "127.0.0.1");

  return finish({
    host,
    port,
    databaseUrl,
    appOrigin,
    clerkIssuer,
    macClientId,
    clerkSecretKey,
    clerkWebhookSecret,
    network,
    push,
    logLevel,
  });
}

import type { Level } from "pino";

export interface Config {
  host: string;
  port: number;
  databaseUrl: string;
  /** The web app's origin, the only page allowed to call the API from a browser. */
  appOrigin: string;
  logLevel: Level;
}

const LEVELS: readonly Level[] = [
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
];

/** Reads the configuration from the environment, refusing to start on anything missing or malformed. */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const problems: string[] = [];
  const read = (name: string, fallback?: string) => {
    const value = env[name]?.trim() || fallback;
    if (value === undefined) problems.push(`${name} is not set`);
    return value ?? "";
  };

  const databaseUrl = read("DATABASE_URL");
  if (databaseUrl && !/^postgres(ql)?:\/\//.test(databaseUrl))
    problems.push("DATABASE_URL is not a postgres:// URL");

  const port = Number(read("PORT", "4000"));
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    problems.push("PORT is not a port number");

  const appOrigin = read("APP_ORIGIN", "https://app.sikemux.com");
  if (appOrigin && URL.parse(appOrigin)?.origin !== appOrigin)
    problems.push("APP_ORIGIN is not an origin like https://app.sikemux.com");

  const logLevel = read("LOG_LEVEL", "info") as Level;
  if (!LEVELS.includes(logLevel))
    problems.push(`LOG_LEVEL is not one of ${LEVELS.join(", ")}`);

  if (problems.length)
    throw new Error(`The API cannot start: ${problems.join("; ")}.`);
  return {
    host: read("HOST", "127.0.0.1"),
    port,
    databaseUrl,
    appOrigin,
    logLevel,
  };
}

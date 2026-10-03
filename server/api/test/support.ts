import { randomBytes } from "node:crypto";
import { validator, type Definitions } from "@sikemux/protocol";
import pg from "pg";
import { inject } from "vitest";

import { createApp, type Services } from "../src/app.ts";
import { openDatabase, type Database } from "../src/db.ts";
import { RateLimiter } from "../src/limits.ts";
import { createLogger } from "../src/log.ts";
import { readNetwork } from "../src/network/network.ts";
import { APP_ORIGIN, verifier } from "./tokens.ts";

export { APP_ORIGIN };

export const log = createLogger("silent");
export const protocol = validator();

/** Reads a response body, failing the test unless it matches the named definition. */
export async function body<Name extends keyof Definitions & string>(
  response: Response,
  name: Name,
): Promise<Definitions[Name]> {
  const result = protocol.validate(name, await response.json());
  if (!result.ok)
    throw new Error(`The body is not a ${name}: ${result.problems.join("; ")}`);
  return result.value;
}

/** A new, empty database for one test file, dropped when the file is done. */
export async function freshDatabase(): Promise<{
  url: string;
  drop(): Promise<void>;
}> {
  const adminUrl = inject("adminUrl");
  const name = `sikemux_test_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`create database ${name}`);
  await admin.end();
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    async drop() {
      const client = new pg.Client({ connectionString: adminUrl });
      await client.connect();
      await client.query(`drop database if exists ${name} with (force)`);
      await client.end();
    },
  };
}

export function testApp(
  database: Database,
  limiter = new RateLimiter(),
  services: Partial<Services> = {},
) {
  return createApp({
    database,
    log,
    appOrigin: APP_ORIGIN,
    verifier,
    limiter,
    clerk: null,
    webhookSecret: null,
    network: readNetwork({}, []),
    push: { app: "production", allowSandbox: false },
    ...services,
  });
}

/** A database whose server is not there, for checking how the API copes without one. */
export function unreachableDatabase(): Database {
  return openDatabase("postgresql://nobody@127.0.0.1:1/nothing", log);
}

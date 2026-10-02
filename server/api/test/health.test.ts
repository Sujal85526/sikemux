import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openDatabase, type Database } from "../src/db.ts";
import {
  body,
  freshDatabase,
  log,
  testApp,
  unreachableDatabase,
} from "./support.ts";

describe("GET /v1/health", () => {
  let database: Database;
  let drop: () => Promise<void>;

  beforeAll(async () => {
    const fresh = await freshDatabase();
    drop = fresh.drop;
    database = openDatabase(fresh.url, log);
  });

  afterAll(async () => {
    await database.close();
    await drop();
  });

  it("answers ok, with the build's version, when the database answers", async () => {
    const response = await testApp(database).request("/v1/health");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await body(response, "Health")).toEqual({
      status: "ok",
      database: "ok",
      version: "dev",
    });
  });

  it("answers 503 quickly when the database is gone, so a deploy check fails", async () => {
    const gone = unreachableDatabase();
    const started = performance.now();
    const response = await testApp(gone).request("/v1/health");
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(response.status).toBe(503);
    expect(await body(response, "Health")).toMatchObject({
      status: "unavailable",
      database: "unavailable",
    });
    await gone.close();
  });
});

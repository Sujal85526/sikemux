import type { Health } from "@sikemux/protocol";
import { Hono } from "hono";

import type { Database } from "../db.ts";
import type { Env } from "../http.ts";
import { version } from "../version.ts";

export function healthRoutes(database: Database) {
  return new Hono<Env>().get("/", async (c) => {
    const reachable = await database.ping(2_000);
    const body: Health = {
      status: reachable ? "ok" : "unavailable",
      database: reachable ? "ok" : "unavailable",
      version,
    };
    c.header("cache-control", "no-store");
    return c.json(body, reachable ? 200 : 503);
  });
}

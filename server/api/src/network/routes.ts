import type { Network } from "@sikemux/protocol";
import { Hono } from "hono";
import { etag } from "hono/etag";

import type { Env } from "../http.ts";
import { clientAddress, limit, type RateLimiter } from "../limits.ts";

/** Public, so a phone can read it before signing in, and the same for everyone, so caches may keep it. */
export function networkRoutes(network: Network, limiter: RateLimiter) {
  return new Hono<Env>().get(
    "/",
    limit<Env>(limiter, "network", 60, clientAddress),
    etag(),
    (c) => {
      c.header("cache-control", "public, max-age=300");
      return c.json(network);
    },
  );
}

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";

import type { Verifier } from "./auth.ts";
import type { Database } from "./db.ts";
import { deviceRoutes } from "./devices/routes.ts";
import { healthRoutes } from "./health/routes.ts";
import { ApiFailure, errorResponse, requestContext, type Env } from "./http.ts";
import { clientAddress, limit, RateLimiter } from "./limits.ts";
import type { Logger } from "./log.ts";
import { updateRoutes } from "./updates/routes.ts";

export interface Services {
  database: Database;
  log: Logger;
  appOrigin: string;
  verifier: Verifier;
  limiter?: RateLimiter;
}

const MAX_BODY_BYTES = 64 * 1024;

export function createApp({
  database,
  log,
  appOrigin,
  verifier,
  limiter = new RateLimiter(),
}: Services) {
  const app = new Hono<Env>();

  app.use(requestContext(log));
  app.use(limit<Env>(limiter, "address", 600, clientAddress));
  app.use(
    cors({
      origin: appOrigin,
      allowMethods: ["GET", "POST", "PATCH", "DELETE"],
      allowHeaders: ["authorization", "content-type"],
      exposeHeaders: ["x-request-id"],
      maxAge: 600,
    }),
  );
  app.use(
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) =>
        errorResponse(
          c,
          413,
          "payload_too_large",
          `Request bodies are limited to ${MAX_BODY_BYTES} bytes.`,
        ),
    }),
  );

  app.route("/v1/health", healthRoutes(database));
  app.route("/v1/devices", deviceRoutes(database, verifier, limiter));
  app.route("/updates", updateRoutes(database, limiter));

  app.notFound((c) =>
    errorResponse(
      c,
      404,
      "not_found",
      `No route matches ${c.req.method} ${c.req.path}.`,
    ),
  );
  app.onError((error, c) => {
    if (error instanceof ApiFailure)
      return errorResponse(c, error.status, error.code, error.message);
    c.get("log").error({ err: error }, "a request failed");
    return errorResponse(c, 500, "internal", "Something failed on the server.");
  });

  return app;
}

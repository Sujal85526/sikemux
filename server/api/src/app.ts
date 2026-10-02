import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";

import type { Database } from "./db.ts";
import { healthRoutes } from "./health/routes.ts";
import { ApiFailure, errorResponse, requestContext, type Env } from "./http.ts";
import type { Logger } from "./log.ts";

export interface Services {
  database: Database;
  log: Logger;
  appOrigin: string;
}

const MAX_BODY_BYTES = 64 * 1024;

export function createApp({ database, log, appOrigin }: Services) {
  const app = new Hono<Env>();

  app.use(requestContext(log));
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

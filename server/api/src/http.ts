import {
  validator,
  type ApiError,
  type Definitions,
  type ErrorCode,
} from "@sikemux/protocol";
import type { Context, MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import type { Logger } from "./log.ts";

export interface Env {
  Variables: {
    requestId: string;
    log: Logger;
  };
}

/** Thrown by a handler to answer with an error the caller can act on. */
export class ApiFailure extends Error {
  readonly status: ContentfulStatusCode;
  readonly code: ErrorCode;

  constructor(status: ContentfulStatusCode, code: ErrorCode, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function errorResponse(
  c: Context<Env>,
  status: ContentfulStatusCode,
  code: ErrorCode,
  message: string,
) {
  const body: ApiError = {
    error: { code, message, requestId: c.get("requestId") },
  };
  return c.json(body, status);
}

/** Gives each request an id, a logger that carries it, and one log line when it finishes. */
export function requestContext(log: Logger): MiddlewareHandler<Env> {
  return async (c, next) => {
    const requestId = crypto.randomUUID();
    const started = performance.now();
    c.set("requestId", requestId);
    c.set("log", log.child({ requestId }));
    c.header("x-request-id", requestId);
    await next();
    c.get("log").info(
      {
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        ms: Math.round(performance.now() - started),
      },
      "request",
    );
  };
}

const protocol = validator();

/** Reads a JSON body and checks it against the named protocol definition before any handler sees it. */
export async function readBody<Name extends keyof Definitions & string>(
  c: Context,
  name: Name,
): Promise<Definitions[Name]> {
  let value: unknown;
  try {
    value = await c.req.json();
  } catch {
    throw new ApiFailure(400, "bad_request", "The body is not JSON.");
  }
  const result = protocol.validate(name, value);
  if (!result.ok)
    throw new ApiFailure(
      400,
      "bad_request",
      `The body is not a valid ${name}: ${result.problems.join("; ")}.`,
    );
  return result.value;
}

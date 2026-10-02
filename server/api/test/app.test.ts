import { Hono } from "hono";
import { afterAll, describe, expect, it } from "vitest";

import { ApiFailure, type Env } from "../src/http.ts";
import { APP_ORIGIN, body, testApp, unreachableDatabase } from "./support.ts";

const database = unreachableDatabase();
afterAll(() => database.close());

describe("every response", () => {
  it("carries a request id that matches the error body", async () => {
    const response = await testApp(database).request("/v1/nothing");
    expect(response.status).toBe(404);
    const { error } = await body(response, "ApiError");
    expect(error.code).toBe("not_found");
    expect(error.requestId).toBe(response.headers.get("x-request-id"));
  });

  it("refuses bodies over 64 KB before any route reads them", async () => {
    const response = await testApp(database).request("/v1/health", {
      method: "POST",
      body: "x".repeat(64 * 1024 + 1),
      headers: { "content-type": "text/plain" },
    });
    expect(response.status).toBe(413);
    expect((await body(response, "ApiError")).error.code).toBe(
      "payload_too_large",
    );
  });
});

describe("browsers", () => {
  it("may call the API from the web app", async () => {
    const response = await testApp(database).request("/v1/health", {
      method: "OPTIONS",
      headers: {
        origin: APP_ORIGIN,
        "access-control-request-method": "DELETE",
      },
    });
    expect(response.headers.get("access-control-allow-origin")).toBe(
      APP_ORIGIN,
    );
    expect(response.headers.get("access-control-allow-methods")).toContain(
      "DELETE",
    );
  });

  it("may not call it from any other page", async () => {
    const response = await testApp(database).request("/v1/health", {
      headers: { origin: "https://evil.example" },
    });
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("failures", () => {
  function appWith(route: (app: Hono<Env>) => void) {
    const app = testApp(database);
    const extra = new Hono<Env>();
    route(extra);
    app.route("/v1/test", extra);
    return app;
  }

  it("answers with the code a handler chose", async () => {
    const app = appWith((extra) =>
      extra.get("/", () => {
        throw new ApiFailure(
          409,
          "conflict",
          "That key is registered to another account.",
        );
      }),
    );
    const response = await app.request("/v1/test");
    expect(response.status).toBe(409);
    expect((await body(response, "ApiError")).error).toMatchObject({
      code: "conflict",
      message: "That key is registered to another account.",
    });
  });

  it("hides the details of anything unexpected", async () => {
    const app = appWith((extra) =>
      extra.get("/", () => {
        throw new Error("connection string with a password in it");
      }),
    );
    const response = await app.request("/v1/test");
    expect(response.status).toBe(500);
    expect((await body(response, "ApiError")).error).toMatchObject({
      code: "internal",
      message: "Something failed on the server.",
    });
  });
});

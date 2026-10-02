import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.ts";

const minimal = { DATABASE_URL: "postgresql://sikemux@localhost/sikemux" };

describe("loadConfig", () => {
  it("listens only on this machine unless told otherwise", () => {
    expect(loadConfig(minimal)).toEqual({
      host: "127.0.0.1",
      port: 4000,
      databaseUrl: minimal.DATABASE_URL,
      appOrigin: "https://app.sikemux.com",
      logLevel: "info",
    });
  });

  it("lists every problem at once", () => {
    expect(() =>
      loadConfig({
        PORT: "eighty",
        APP_ORIGIN: "https://app.sikemux.com/",
        LOG_LEVEL: "loud",
      }),
    ).toThrow(
      "The API cannot start: DATABASE_URL is not set; PORT is not a port number; APP_ORIGIN is not an origin like https://app.sikemux.com; LOG_LEVEL is not one of fatal, error, warn, info, debug, trace.",
    );
  });
});

import { describe, expect, it } from "vitest";

import { loadConfig, loadMigrationConfig } from "../src/config.ts";
import { readNetwork } from "../src/network/network.ts";

const minimal = {
  DATABASE_URL: "postgresql://sikemux@localhost/sikemux",
  CLERK_ISSUER: "https://clerk.sikemux.com",
  CLERK_MAC_CLIENT_ID: "mac_client",
};

describe("loadConfig", () => {
  it("listens only on this machine unless told otherwise", () => {
    expect(loadConfig(minimal)).toEqual({
      host: "127.0.0.1",
      port: 4000,
      databaseUrl: minimal.DATABASE_URL,
      appOrigin: "https://app.sikemux.com",
      clerkIssuer: "https://clerk.sikemux.com",
      macClientId: "mac_client",
      clerkSecretKey: null,
      clerkWebhookSecret: null,
      network: readNetwork({}, []),
      logLevel: "info",
    });
  });

  it("takes Clerk's secret key and webhook secret when they are set", () => {
    expect(
      loadConfig({
        ...minimal,
        CLERK_SECRET_KEY: "sk_live_abc",
        CLERK_WEBHOOK_SECRET: "whsec_c2VjcmV0",
      }),
    ).toMatchObject({
      clerkSecretKey: "sk_live_abc",
      clerkWebhookSecret: "whsec_c2VjcmV0",
    });
  });

  it("refuses secrets that are not Clerk's", () => {
    expect(() =>
      loadConfig({
        ...minimal,
        CLERK_SECRET_KEY: "pk_live_abc",
        CLERK_WEBHOOK_SECRET: "c2VjcmV0",
      }),
    ).toThrow(
      "CLERK_SECRET_KEY is not a secret key like sk_live_…; CLERK_WEBHOOK_SECRET is not a signing secret like whsec_…",
    );
  });

  it("lists every problem at once", () => {
    expect(() =>
      loadConfig({
        PORT: "eighty",
        APP_ORIGIN: "https://app.sikemux.com/",
        CLERK_ISSUER: "http://clerk.sikemux.com",
        LOG_LEVEL: "loud",
      }),
    ).toThrow(
      "The API cannot start: DATABASE_URL is not set; PORT is not a port number; APP_ORIGIN is not an origin like https://app.sikemux.com; CLERK_ISSUER is not an https origin like https://clerk.sikemux.com; CLERK_MAC_CLIENT_ID is not set; LOG_LEVEL is not one of fatal, error, warn, info, debug, trace.",
    );
  });
});

describe("loadMigrationConfig", () => {
  it("needs only the database, so a deploy migrates without the server's settings", () => {
    expect(loadMigrationConfig({ DATABASE_URL: minimal.DATABASE_URL })).toEqual(
      { databaseUrl: minimal.DATABASE_URL, logLevel: "info" },
    );
  });

  it("still refuses a database that is not postgres", () => {
    expect(() =>
      loadMigrationConfig({ DATABASE_URL: "mysql://localhost/sikemux" }),
    ).toThrow("DATABASE_URL is not a postgres:// URL");
  });
});

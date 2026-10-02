import { describe, expect, it } from "vitest";

import { ApiFailure } from "../src/http.ts";
import {
  APP_ORIGIN,
  macToken,
  otherSigningKey,
  sessionToken,
  verifier,
} from "./tokens.ts";

async function refusal(token: Promise<string> | string) {
  try {
    await verifier.verify(await token);
  } catch (error) {
    if (error instanceof ApiFailure)
      return { status: error.status, message: error.message };
    throw error;
  }
  throw new Error("the token was accepted");
}

describe("clerkVerifier", () => {
  it("accepts a session token from the phone, which names no site", async () => {
    await expect(
      verifier.verify(await sessionToken("user_1")),
    ).resolves.toEqual({ userId: "user_1", via: "session" });
  });

  it("accepts a session token from the web app", async () => {
    const token = await sessionToken("user_1", { claims: { azp: APP_ORIGIN } });
    await expect(verifier.verify(token)).resolves.toEqual({
      userId: "user_1",
      via: "session",
    });
  });

  it("accepts the Mac app's OAuth token", async () => {
    await expect(verifier.verify(await macToken("user_1"))).resolves.toEqual({
      userId: "user_1",
      via: "mac",
    });
  });

  const refused: [string, () => Promise<string> | string, string][] = [
    ["garbage", () => "not.a.token", "not valid"],
    [
      "a token signed by another key",
      async () => sessionToken("user_1", { key: await otherSigningKey() }),
      "not valid",
    ],
    [
      "a token from another Clerk instance",
      () =>
        sessionToken("user_1", { issuer: "https://evil.clerk.accounts.dev" }),
      "not valid",
    ],
    [
      "an expired token",
      () => sessionToken("user_1", { expiresIn: "-1m" }),
      "expired",
    ],
    [
      "a session token from another site",
      () => sessionToken("user_1", { claims: { azp: "https://evil.example" } }),
      "another site",
    ],
    [
      "a session that has not finished signing in",
      () => sessionToken("user_1", { claims: { sts: "pending" } }),
      "not finished",
    ],
    [
      "an OAuth token issued to another app",
      () => macToken("user_1", { claims: { client_id: "someone_else" } }),
      "another app",
    ],
    [
      "a token without a session or OAuth type",
      () => sessionToken("user_1", { claims: { sid: undefined } }),
      "not a session",
    ],
    [
      "a token for a machine, not a user",
      () => sessionToken("mch_1"),
      "not for a user",
    ],
  ];
  for (const [what, token, message] of refused) {
    it(`refuses ${what}`, async () => {
      const result = await refusal(token());
      expect(result.status).toBe(401);
      expect(result.message).toContain(message);
    });
  }
});

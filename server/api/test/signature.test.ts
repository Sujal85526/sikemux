import { describe, expect, it } from "vitest";

import live from "../../protocol/vectors/live.json" with { type: "json" };
import vector from "../../protocol/vectors/registration.json" with { type: "json" };
import {
  liveMessage,
  registrationMessage,
  signedBy,
} from "../src/devices/signature.ts";

describe("registration signatures", () => {
  it("verify the vector the core signs", () => {
    const message = registrationMessage(
      vector.nonce,
      vector.userId,
      vector.key,
    );
    expect(message).toBe(vector.message);
    expect(signedBy(vector.key, message, vector.signature)).toBe(true);
  });

  it("fail for any other account, challenge or key", () => {
    expect(
      signedBy(
        vector.key,
        registrationMessage(vector.nonce, "user_other", vector.key),
        vector.signature,
      ),
    ).toBe(false);
    expect(
      signedBy(
        vector.key,
        registrationMessage("0".repeat(64), vector.userId, vector.key),
        vector.signature,
      ),
    ).toBe(false);
    expect(signedBy("0".repeat(64), vector.message, vector.signature)).toBe(
      false,
    );
  });
});

describe("live connection signatures", () => {
  it("verify the vector the core and the phone sign", () => {
    const message = liveMessage(live.nonce, live.key);
    expect(message).toBe(live.message);
    expect(signedBy(live.key, message, live.signature)).toBe(true);
  });

  it("never stand in for a registration, nor a registration for them", () => {
    expect(live.key).toBe(vector.key);
    expect(live.nonce).toBe(vector.nonce);
    expect(signedBy(live.key, vector.message, live.signature)).toBe(false);
    expect(
      signedBy(vector.key, liveMessage(live.nonce, live.key), vector.signature),
    ).toBe(false);
  });

  it("fail for another challenge or key", () => {
    expect(
      signedBy(live.key, liveMessage("0".repeat(64), live.key), live.signature),
    ).toBe(false);
    expect(
      signedBy(
        "0".repeat(64),
        liveMessage(live.nonce, "0".repeat(64)),
        live.signature,
      ),
    ).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import vector from "../../protocol/vectors/registration.json" with { type: "json" };
import { registrationMessage, signedBy } from "../src/devices/signature.ts";

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

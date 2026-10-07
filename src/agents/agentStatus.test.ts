import { describe, expect, it } from "vitest";
import { agentCanStart, agentStatusLabel } from "./agentStatus";

describe("agentStatus", () => {
    it("names each status in a few words, and says nothing when it cannot tell", () => {
        expect(agentStatusLabel({ state: "missing" })).toBe("Not installed");
        expect(agentStatusLabel({ state: "broken", reason: "exit 127" })).toBe("Not working");
        expect(agentStatusLabel({ state: "signedOut" })).toBe("Signed out");
        expect(agentStatusLabel({ state: "ready", account: "subscription" })).toBe("Ready · subscription");
        expect(agentStatusLabel({ state: "ready", account: "apiKey" })).toBe("Ready · API key");
        expect(agentStatusLabel({ state: "ready", account: null })).toBe("Ready");
        expect(agentStatusLabel({ state: "unknown" })).toBeNull();
        expect(agentStatusLabel(undefined)).toBeNull();
    });

    it("lets a signed-out agent start, since it asks to sign in, but not a missing or broken one", () => {
        expect(agentCanStart({ state: "signedOut" })).toBe(true);
        expect(agentCanStart({ state: "unknown" })).toBe(true);
        expect(agentCanStart(undefined)).toBe(true);
        expect(agentCanStart({ state: "missing" })).toBe(false);
        expect(agentCanStart({ state: "broken", reason: "x" })).toBe(false);
    });
});

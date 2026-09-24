import { describe, expect, it } from "vitest";
import { signozSettings, type SignozSettings } from "./state";

describe("signozSettings", () => {
    it("falls back to usable settings whatever was saved", () => {
        const saved = { minutes: 7, serviceByProject: { "/repo": "api", "/bad": 3 } } as unknown as SignozSettings;
        signozSettings.update(() => saved);
        expect(signozSettings.get()).toEqual({ minutes: 15, serviceByProject: { "/repo": "api" } });
        signozSettings.update(() => ({ minutes: 60, serviceByProject: {} }));
        expect(signozSettings.get().minutes).toBe(60);
    });
});

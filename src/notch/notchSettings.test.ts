import { describe, expect, it } from "vitest";
import { DEFAULT_NOTCH_SETTINGS, normaliseNotchSettings } from "./notchSettings";

describe("normaliseNotchSettings", () => {
    it("fills what was never saved with the defaults", () => {
        expect(normaliseNotchSettings(undefined)).toEqual(DEFAULT_NOTCH_SETTINGS);
        expect(normaliseNotchSettings({ sound: false })).toEqual({ ...DEFAULT_NOTCH_SETTINGS, sound: false });
    });

    it("drops values the helper would not understand", () => {
        expect(normaliseNotchSettings({ displays: "everywhere", openWith: 3, peeks: "never" })).toEqual({
            ...DEFAULT_NOTCH_SETTINGS,
            peeks: "never",
        });
    });
});

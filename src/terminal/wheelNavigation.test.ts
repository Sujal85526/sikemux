import { describe, expect, it } from "vitest";
import { alternateScreenWheelFallbackSequence, type AlternateScreenWheelGesture } from "./wheelNavigation";

const gesture = (overrides: Partial<AlternateScreenWheelGesture> = {}): AlternateScreenWheelGesture => ({
    defaultPrevented: false,
    bufferType: "alternate",
    mouseTrackingMode: "none",
    applicationCursorKeysMode: false,
    deltaX: 0,
    deltaY: -1,
    ...overrides,
});

describe("alternate-screen wheel fallback", () => {
    it("turns even a precision trackpad gesture into cursor movement", () => {
        expect(alternateScreenWheelFallbackSequence(gesture())).toBe("\x1b[A");
        expect(alternateScreenWheelFallbackSequence(gesture({ deltaY: 1 }))).toBe("\x1b[B");
    });

    it("uses application cursor sequences and caps large gestures", () => {
        expect(alternateScreenWheelFallbackSequence(gesture({ applicationCursorKeysMode: true, deltaY: -400 }))).toBe("\x1bOA".repeat(6));
    });

    it("does not duplicate wheel input already handled by xterm", () => {
        expect(alternateScreenWheelFallbackSequence(gesture({ defaultPrevented: true }))).toBeNull();
    });

    it("leaves normal scrollback and application mouse tracking to xterm", () => {
        expect(alternateScreenWheelFallbackSequence(gesture({ bufferType: "normal" }))).toBeNull();
        expect(alternateScreenWheelFallbackSequence(gesture({ mouseTrackingMode: "any" }))).toBeNull();
    });

    it("ignores horizontal and empty gestures", () => {
        expect(alternateScreenWheelFallbackSequence(gesture({ deltaX: 2, deltaY: 1 }))).toBeNull();
        expect(alternateScreenWheelFallbackSequence(gesture({ deltaY: 0 }))).toBeNull();
    });
});

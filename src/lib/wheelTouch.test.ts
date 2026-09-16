import { beforeEach, describe, expect, it, vi } from "vitest";
import { fingersDown, onFingersLift, setFingersDown } from "./wheelTouch";

beforeEach(() => setFingersDown(false));

describe("wheel touch", () => {
    it("is down only while macOS says a hand is on the trackpad", () => {
        expect(fingersDown()).toBe(false);
        setFingersDown(true);
        expect(fingersDown()).toBe(true);
        setFingersDown(false);
        expect(fingersDown()).toBe(false);
    });

    /*
     * The lift is what ends a swipe, and it is reported once however many scroll
     * events carry it, so a swipe can never be ended twice by the same hand.
     */
    it("reports a lift once, and not the landing", () => {
        const lifted = vi.fn();
        onFingersLift(lifted);

        setFingersDown(true);
        setFingersDown(true);
        expect(lifted).not.toHaveBeenCalled();

        setFingersDown(false);
        setFingersDown(false);
        expect(lifted).toHaveBeenCalledTimes(1);
    });

    it("stops reporting once a listener has gone", () => {
        const lifted = vi.fn();
        onFingersLift(lifted)();

        setFingersDown(true);
        setFingersDown(false);

        expect(lifted).not.toHaveBeenCalled();
    });
});

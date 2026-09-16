import { beforeEach, describe, expect, it, vi } from "vitest";
import { fingersDown, onFingers, setFingersDown } from "./wheelTouch";

beforeEach(() => setFingersDown(null));

describe("wheel touch", () => {
    it("is neither until something says a hand is on the trackpad", () => {
        expect(fingersDown()).toBe(null);
        setFingersDown(true);
        expect(fingersDown()).toBe(true);
        setFingersDown(false);
        expect(fingersDown()).toBe(false);
    });

    /*
     * A landing starts a swipe and a lift ends one, and each is reported once
     * however many scroll events carry it.
     */
    it("reports each landing and lift once", () => {
        const moves: boolean[] = [];
        onFingers((down) => moves.push(down));

        setFingersDown(true);
        setFingersDown(true);
        setFingersDown(false);
        setFingersDown(false);
        setFingersDown(true);

        expect(moves).toEqual([true, false, true]);
    });

    /* Nobody watching is not the same as a hand having lifted, and says nothing. */
    it("says nothing when it stops knowing", () => {
        const moved = vi.fn();
        setFingersDown(true);
        onFingers(moved);

        setFingersDown(null);

        expect(moved).not.toHaveBeenCalled();
        expect(fingersDown()).toBe(null);
    });

    it("stops reporting once a listener has gone", () => {
        const moved = vi.fn();
        onFingers(moved)();

        setFingersDown(true);
        setFingersDown(false);

        expect(moved).not.toHaveBeenCalled();
    });
});

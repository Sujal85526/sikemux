import { describe, expect, it } from "vitest";
import { claimsWheel, dragOffset, snapTarget, wheelVelocity } from "./wheelPan";
import type { PaneScroller } from "./wheelPan";

const plain: PaneScroller = { overflowX: "visible", scrollWidth: 100, clientWidth: 100, scrollLeft: 0 };
const scroller = (over: Partial<PaneScroller> = {}): PaneScroller => ({
    overflowX: "auto",
    scrollWidth: 500,
    clientWidth: 200,
    scrollLeft: 100,
    ...over,
});

const bothWays = { hasPrevious: true, hasNext: true };
const firstScreen = { hasPrevious: false, hasNext: true };
const lastScreen = { hasPrevious: true, hasNext: false };

describe("claimsWheel", () => {
    it("takes a flat sideways gesture over nothing that scrolls", () => {
        expect(claimsWheel([plain, plain], 40, 2)).toBe(true);
    });

    /*
     * A gesture going mostly down the screen is somebody scrolling a pane with a
     * little sideways drift, not a swipe between screens.
     */
    it("leaves a gesture that is mostly vertical alone", () => {
        expect(claimsWheel([plain], 20, 20)).toBe(false);
        expect(claimsWheel([plain], 20, 14)).toBe(false);
        expect(claimsWheel([plain], 20, 12)).toBe(true);
    });

    it("leaves the gesture to a pane that can still scroll the way it is going", () => {
        expect(claimsWheel([plain, scroller()], 40, 0)).toBe(false);
        expect(claimsWheel([scroller(), plain], -40, 0)).toBe(false);
    });

    /*
     * The decision is made once, on the gesture's first event, so a pane already
     * at its edge never gets the gesture and a pane that reaches its edge
     * mid-swipe keeps it — the caller latches what this returns.
     */
    it("takes the gesture when the pane is already at the edge it is heading for", () => {
        expect(claimsWheel([scroller({ scrollLeft: 300 })], 40, 0)).toBe(true);
        expect(claimsWheel([scroller({ scrollLeft: 0 })], -40, 0)).toBe(true);
        expect(claimsWheel([scroller({ scrollLeft: 0 })], 40, 0)).toBe(false);
    });

    it("ignores a pane whose content fits, however it declares its overflow", () => {
        expect(claimsWheel([scroller({ scrollWidth: 200 })], 40, 0)).toBe(true);
        expect(claimsWheel([scroller({ overflowX: "hidden" })], 40, 0)).toBe(true);
    });
});

describe("dragOffset", () => {
    it("follows the finger up to the screen next door", () => {
        expect(dragOffset(0.4, bothWays)).toBeCloseTo(0.4);
        expect(dragOffset(-0.4, bothWays)).toBeCloseTo(-0.4);
        expect(dragOffset(1.8, bothWays)).toBe(1);
        expect(dragOffset(-1.8, bothWays)).toBe(-1);
    });

    /*
     * Past the last screen there is nothing to uncover, so the track gives a
     * little and then stops giving rather than sliding off into blank stage.
     */
    it("resists past the ends of the session", () => {
        expect(dragOffset(0.4, lastScreen)).toBeLessThan(0.15);
        expect(dragOffset(0.4, lastScreen)).toBeGreaterThan(0);
        expect(dragOffset(50, lastScreen)).toBeLessThan(0.15);
        expect(dragOffset(-0.4, firstScreen)).toBeGreaterThan(-0.15);
        expect(dragOffset(-0.4, firstScreen)).toBeLessThan(0);
    });

    it("still runs free towards the end that has a screen", () => {
        expect(dragOffset(0.4, firstScreen)).toBeCloseTo(0.4);
        expect(dragOffset(-0.4, lastScreen)).toBeCloseTo(-0.4);
    });
});

describe("wheelVelocity", () => {
    it("measures the screens covered over the time the last events took", () => {
        expect(
            wheelVelocity([
                { delta: 0.1, at: 0 },
                { delta: 0.1, at: 50 },
                { delta: 0.1, at: 100 },
            ]),
        ).toBeCloseTo(0.002);
    });

    it("has no opinion about a single event or a stalled one", () => {
        expect(wheelVelocity([])).toBe(0);
        expect(wheelVelocity([{ delta: 0.3, at: 10 }])).toBe(0);
        expect(
            wheelVelocity([
                { delta: 0.3, at: 10 },
                { delta: 0.3, at: 10 },
            ]),
        ).toBe(0);
    });

    /*
     * A swipe that ran on and then stopped dead should read as stopped, so only
     * the tail of the gesture counts.
     */
    it("only looks at the tail of a long gesture", () => {
        const long = Array.from({ length: 20 }, (_, index) => ({ delta: index < 15 ? 0.2 : 0, at: index * 10 }));
        expect(wheelVelocity(long)).toBe(0);
    });
});

describe("snapTarget", () => {
    it("takes the neighbour once the drag is past half a screen", () => {
        expect(snapTarget(0.6, 0, bothWays)).toBe(1);
        expect(snapTarget(-0.6, 0, bothWays)).toBe(-1);
        expect(snapTarget(0.4, 0, bothWays)).toBe(0);
    });

    it("takes the neighbour on a flick that never got halfway", () => {
        expect(snapTarget(0.1, 0.004, bothWays)).toBe(1);
        expect(snapTarget(-0.1, -0.004, bothWays)).toBe(-1);
        expect(snapTarget(0.1, 0.0005, bothWays)).toBe(0);
    });

    /*
     * Every event of a gesture asks this, so the first fast one arrives when the
     * track has barely moved. That is a scroll getting going, not a flick.
     */
    it("wants a flick to have moved the track before it counts as one", () => {
        expect(snapTarget(0.02, 0.004, bothWays)).toBe(0);
        expect(snapTarget(-0.02, -0.004, bothWays)).toBe(0);
    });

    /*
     * Dragging a long way and then throwing the screen back is how you cancel a
     * swipe you changed your mind about.
     */
    it("puts the screen back when the flick goes against the drag", () => {
        expect(snapTarget(0.8, -0.004, bothWays)).toBe(0);
        expect(snapTarget(-0.8, 0.004, bothWays)).toBe(0);
    });

    it("has nowhere to go past the ends of the session", () => {
        expect(snapTarget(0.1, 0.004, lastScreen)).toBe(0);
        expect(snapTarget(-0.1, -0.004, firstScreen)).toBe(0);
    });
});

import { describe, expect, it } from "vitest";
import { claimsWheel, dragOffset, panned } from "./wheelPan";
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
    /*
     * There is no ceiling on the pull any more: a drag that runs past a screen
     * hands the session on to that screen and carries on from there, so the
     * number this returns is only ever the finger itself.
     */
    it("follows the finger one for one", () => {
        expect(dragOffset(0.4, bothWays)).toBeCloseTo(0.4);
        expect(dragOffset(-0.4, bothWays)).toBeCloseTo(-0.4);
        expect(dragOffset(1.8, bothWays)).toBeCloseTo(1.8);
        expect(dragOffset(-1.8, bothWays)).toBeCloseTo(-1.8);
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

    /*
     * All of the give spent in the first fraction of the pull is a stop, not a
     * wall: the rest of the finger travel moves nothing and reads as broken.
     */
    it("spreads the give over a screen of pull rather than spending it at once", () => {
        expect(dragOffset(0.25, lastScreen)).toBeLessThan(0.075);
        expect(dragOffset(1.5, lastScreen)).toBeGreaterThan(0.12);
        expect(dragOffset(1.5, lastScreen)).toBeGreaterThan(dragOffset(0.5, lastScreen));
    });

    it("still runs free towards the end that has a screen", () => {
        expect(dragOffset(0.4, firstScreen)).toBeCloseTo(0.4);
        expect(dragOffset(-0.4, lastScreen)).toBeCloseTo(-0.4);
    });
});

describe("panned", () => {
    const SCREENS = 6;

    it("leaves the track where the finger is until a screen is more than half on", () => {
        expect(panned(0.5, 2, SCREENS)).toEqual({ slot: 2, raw: 0.5, offset: 0.5 });
        expect(panned(-0.5, 2, SCREENS)).toEqual({ slot: 2, raw: -0.5, offset: -0.5 });
    });

    /*
     * Stepping on takes a whole screen off the pull, so the track does not move
     * an inch: it was 0.6 of a screen past screen two and is now 0.4 of a screen
     * short of screen three, which is the same place.
     */
    it("counts from the screen more than half on without moving the track", () => {
        const now = panned(0.6, 2, SCREENS);
        expect(now.slot).toBe(3);
        expect(now.offset).toBeCloseTo(-0.4);
        expect(now.slot + now.offset).toBeCloseTo(2.6);
    });

    /*
     * Half a screen is the only threshold that can do this: the screen just
     * stepped off is exactly that far the other way, so anything shorter would
     * step straight back and the session would flicker between the two.
     */
    it("never steps back onto the screen it has just left", () => {
        for (const pull of [0.501, 0.6, 0.9, 1]) {
            expect(panned(pull, 2, SCREENS).slot).toBe(3);
        }
    });

    it("runs through as many screens as one long pull reaches", () => {
        const now = panned(2.7, 1, SCREENS);
        expect(now.slot).toBe(4);
        expect(now.slot + now.offset).toBeCloseTo(3.7);
        expect(panned(-2.7, 4, SCREENS).slot).toBe(1);
    });

    /*
     * There is nothing past the last screen to step onto, so however hard the
     * pull is it only ever buys a little give.
     */
    it("stops at the ends of the session and resists instead", () => {
        const end = panned(3, SCREENS - 1, SCREENS);
        expect(end.slot).toBe(SCREENS - 1);
        expect(end.offset).toBeGreaterThan(0);
        expect(end.offset).toBeLessThan(0.15);

        const start = panned(-3, 0, SCREENS);
        expect(start.slot).toBe(0);
        expect(start.offset).toBeLessThan(0);
        expect(start.offset).toBeGreaterThan(-0.15);
    });
});

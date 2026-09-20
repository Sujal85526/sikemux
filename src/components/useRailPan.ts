import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import { prefersReducedMotion } from "../lib/motion";
import { claimsWheel, endDelay, flicked, panned, pulledOn, pushed, thrust } from "./wheelPan";
import type { PaneScroller, Push } from "./wheelPan";
import { fingersDown, onFingers, watchFingers } from "../lib/wheelTouch";
import { PAN_MS, RETURN_MS, settleMs } from "./useWindowPan";

/**
 * A two-finger swipe across a run of pages, for the rail.
 *
 * The physics is the stage's, not a second opinion about how a swipe should
 * feel: `wheelPan.ts` decides what the gesture claims, how far a pull moves the
 * track, how hard the ends resist and whether a swipe was thrown or placed, and
 * `wheelTouch` says when the hand actually left the trackpad. Only the
 * orchestration differs — the stage walks windows within a session and parks
 * layers so a twenty-screen jump still travels one screen, while the rail has
 * every page mounted side by side and only has to slide.
 *
 * Nothing here waits on React. The transform is written straight to the element
 * from a frame loop; React is told which page won, once, when it wins.
 */
export interface RailPan {
    /** True while a gesture holds the track, so the stylesheet can drop its transition. */
    readonly panning: boolean;
}

/** What one page of travel is worth. The rail has no gap between its pages. */
const offsetOf = (at: number) => `${-at * 100}%`;

interface Gesture {
    /** Whether the rail took this gesture, decided once on its first event. */
    readonly claimed: boolean;
    /** One page of finger travel, in pixels. */
    readonly stride: number;
    slot: number;
    raw: number;
    offset: number;
    /** The way the hand was last going, which is not the way the track sits once a pull has crossed. */
    way: number;
    /** The last moments of the swipe, which say whether it was thrown or placed. */
    pushes: readonly Push[];
    /** Whether the swipe has already landed, so what still arrives is only its tail. */
    spent: boolean;
    frame: number | null;
}

/** Everything between the wheel event and the track that might scroll sideways itself. */
function scrollersUnder(target: EventTarget | null, root: Element): PaneScroller[] {
    const chain: PaneScroller[] = [];
    let node = target instanceof Element ? target : null;
    while (node && node !== root) {
        const style = getComputedStyle(node);
        chain.push({ overflowX: style.overflowX, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth, scrollLeft: node.scrollLeft });
        node = node.parentElement;
    }
    return chain;
}

/**
 * @param viewportRef the box that stays put and clips — a transformed element
 *        carries its own overflow, so the track cannot be the one clipping.
 * @param trackRef    the box that slides.
 * @param pages       how many are mounted.
 * @param index       which one is in front.
 * @param onIndex     called as the gesture crosses onto a page, not only at the end,
 *                    so one long pull walks through as many as it has reach.
 */
export function useRailPan(
    viewportRef: RefObject<HTMLElement | null>,
    trackRef: RefObject<HTMLElement | null>,
    pages: number,
    index: number,
    onIndex: (index: number) => void,
): RailPan {
    const live = useRef({ pages, index, onIndex });
    live.current = { pages, index, onIndex };
    const held = useRef(false);
    const panning = useRef(false);

    /* React never writes the transform. It would fight the frame loop for the
       same property every time a crossing re-rendered, and lose a frame to it. */
    useEffect(() => {
        const track = trackRef.current;
        if (!track || held.current) return;
        track.style.setProperty("--rail-pan", offsetOf(index));
    }, [index, trackRef]);

    useEffect(() => {
        const viewport = viewportRef.current;
        if (!viewport) return;
        let gesture: Gesture | null = null;
        let quiet: number | null = null;

        const forget = () => {
            if (gesture?.frame != null) cancelAnimationFrame(gesture.frame);
            if (quiet != null) window.clearTimeout(quiet);
            gesture = null;
            quiet = null;
            held.current = false;
            panning.current = false;
            viewport.classList.remove("is-panning");
        };

        const paint = () => {
            const moving = gesture;
            const track = trackRef.current;
            if (!moving || !track) return;
            moving.frame = null;
            track.style.setProperty("--rail-pan", offsetOf(moving.slot + moving.offset));
        };

        /* Closes the swipe onto a page. The finger leaves the track at most half a
           page from the one it is on, unless the swipe was thrown rather than
           placed, which carries it one further the way it went.

           Going back against the hand is a different movement from carrying on the
           way it went, and takes a curve and a time of its own — see the stage's
           `land`, which this is the same close as. */
        const land = (until: number) => {
            const done = gesture;
            const track = trackRef.current;
            if (!done || done.spent) return;
            done.spent = true;
            if (done.frame != null) cancelAnimationFrame(done.frame);
            done.frame = null;
            if (!done.claimed || !track) return forget();
            // Thrown at the next page, or else pulled far enough onto it to have chosen
            // it — see the stage's `land` for why a pull that has crossed has already
            // spent its throw.
            const flick = flicked(done.pushes, until) || pulledOn(done.offset, done.way);
            const thrown = flick * done.offset < 0 ? 0 : flick;
            const onto = Math.max(0, Math.min(live.current.pages - 1, done.slot + thrown));
            const travel = onto - (done.slot + done.offset);
            const returning = travel * thrust(done.pushes, until) < 0;
            forget();
            track.classList.toggle("returning", returning);
            if (!prefersReducedMotion()) track.style.setProperty("--rail-pan-ms", `${returning ? RETURN_MS : settleMs(Math.abs(travel))}ms`);
            track.style.setProperty("--rail-pan", offsetOf(onto));
            if (onto !== live.current.index) live.current.onIndex(onto);
        };

        const settle = () => land(performance.now());

        const onWheel = (event: WheelEvent) => {
            const track = trackRef.current;
            if (!track || live.current.pages < 2) return;
            if (!gesture) {
                const stride = viewport.clientWidth;
                if (stride <= 0) return;
                gesture = {
                    claimed: claimsWheel(scrollersUnder(event.target, viewport), event.deltaX, event.deltaY),
                    stride,
                    slot: live.current.index,
                    raw: 0,
                    offset: 0,
                    way: 0,
                    pushes: [],
                    spent: false,
                    frame: null,
                };
            }
            const moving = gesture;
            if (quiet != null) window.clearTimeout(quiet);
            quiet = window.setTimeout(settle, endDelay(fingersDown()));
            if (!moving.claimed) return;
            // Whatever is underneath must not scroll sideways as well.
            event.preventDefault();
            // Everything arriving after the hand left is the tail of a swipe that
            // has already landed, not more of it.
            if (moving.spent) return;

            if (!held.current) {
                held.current = true;
                panning.current = true;
                track.style.removeProperty("--rail-pan-ms");
                viewport.classList.add("is-panning");
            }
            const at = performance.now();
            moving.pushes = pushed(moving.pushes, at, event.deltaX);
            moving.way = Math.sign(event.deltaX) || moving.way;
            const was = moving.slot;
            const now = panned(moving.raw + event.deltaX / moving.stride, moving.slot, live.current.pages);
            moving.slot = now.slot;
            moving.raw = now.raw;
            moving.offset = now.offset;
            // A page dragged more than halfway on is the page you are on, so a
            // long pull runs through as many as it reaches.
            if (moving.slot !== was) live.current.onIndex(moving.slot);
            if (moving.frame == null) moving.frame = requestAnimationFrame(paint);
        };

        const watched = onFingers((down) => {
            // The hand leaving is the end of the swipe. Waiting for the glide it
            // left to run out would hold the track still for as long as that took.
            if (!down) return land(performance.now());
            // And a hand coming back down is a new swipe, whatever the last one left.
            if (gesture?.spent) forget();
        });
        const watching = new AbortController();
        watchFingers(watching.signal);
        viewport.addEventListener("wheel", onWheel, { passive: false });
        return () => {
            viewport.removeEventListener("wheel", onWheel);
            watching.abort();
            watched();
            forget();
        };
    }, [viewportRef, trackRef]);

    return { panning: panning.current };
}

export { PAN_MS };

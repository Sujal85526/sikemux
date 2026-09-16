import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import * as cmd from "../state/commands";
import { fingersDown, onFingersLift, watchFingers } from "../lib/wheelTouch";
import { getState } from "../state/store";
import { panOffset, settleMs } from "./useWindowPan";
import type { WindowPan } from "./useWindowPan";
import { claimsWheel, endDelay, SPENT_END_MS, panned } from "./wheelPan";
import type { PaneScroller } from "./wheelPan";

interface Gesture {
    /** Whether the stage took this gesture, decided once on its first event. */
    readonly claimed: boolean;
    /** One screen of finger travel in pixels: the stage plus the gap between cards. */
    readonly stride: number;
    /** The screen the track is based on, which a crossing moves along. */
    slot: number;
    /** Screens dragged from that screen, before the ends of the session resist the pull. */
    raw: number;
    /** How far past that screen the track sits, which is what reaches `--pan`. */
    offset: number;
    /** The screen showing beside it, which is the one the drag is heading for. */
    toward: string | null;
    /** Whether React has been handed the pair of screens the gesture is between. */
    held: boolean;
    frame: number | null;
}

/** The gap the cards keep between them, which only the stylesheet knows. */
function cardGap(area: HTMLElement): number {
    // jsdom reports no custom properties, so a test stage has no gap.
    return Number.parseFloat(getComputedStyle(area).getPropertyValue("--window-card-gap")) || 0;
}

/** Everything between the wheel event and its screen that might want to scroll sideways instead. */
function scrollersUnder(target: EventTarget | null): PaneScroller[] {
    const chain: PaneScroller[] = [];
    let node = target instanceof Element ? target : null;
    while (node && !node.classList.contains("window-layer")) {
        const style = getComputedStyle(node);
        chain.push({ overflowX: style.overflowX, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth, scrollLeft: node.scrollLeft });
        node = node.parentElement;
    }
    return chain;
}

/**
 * Drags the track sideways with a two-finger trackpad swipe, the way a paged
 * scroller does: the track follows the finger for as long as the finger moves,
 * and a screen dragged more than halfway on is the screen the session is on.
 *
 * Making it active is not a landing. The track keeps following the finger from
 * the new screen, so a long swipe runs through as many screens as it has reach
 * while only the two either side of the finger ever paint. Only when the events
 * stop does anything animate, and then only to close the last half screen.
 *
 * Nothing here may wait on React. `--pan` is written straight to the element
 * from a frame loop, the session is read back out of the store rather than off
 * a prop, and React is told two things: which screen is active and which layers
 * paint.
 */
export function useWheelPan(areaRef: RefObject<HTMLElement | null>, pan: WindowPan): void {
    const latest = useRef(pan);
    latest.current = pan;

    useEffect(() => {
        const area = areaRef.current;
        if (!area) return;
        let gesture: Gesture | null = null;
        let quiet: number | null = null;

        /** The live session's screens and the one it is on, read where the gesture
         *  put them rather than where a render would have them. */
        const session = () => {
            const state = getState();
            return {
                order: state.windowsBySession[state.activeSessionId] ?? [],
                on: state.sessions[state.activeSessionId]?.activeWindowId ?? null,
            };
        };

        const forget = () => {
            if (gesture?.frame != null) cancelAnimationFrame(gesture.frame);
            if (quiet != null) window.clearTimeout(quiet);
            gesture = null;
            quiet = null;
        };

        const paint = () => {
            const moving = gesture;
            if (!moving) return;
            moving.frame = null;
            const { order, on } = session();
            if (order[moving.slot] !== on) return;
            latest.current.trackRef.current?.style.setProperty("--pan", panOffset(moving.slot + moving.offset));
        };

        // Whatever screen the gesture left the session on is the one the track
        // closes onto, which is at most half a screen away.
        const settle = () => {
            const done = gesture;
            forget();
            if (!done?.claimed || !done.held) return;
            const { order, on } = session();
            if (on !== null && order[done.slot] === on) latest.current.snap(on, done.toward, settleMs(Math.abs(done.offset)));
        };

        const onWheel = (event: WheelEvent) => {
            // The strip sits on the stage and scrolls itself.
            if (event.target instanceof Element && event.target.closest(".tabbar")) return;
            const { order, on } = session();
            // A switch from somewhere else takes the track away, and the pan the
            // gesture was driving is that switch's slide by now.
            if (gesture && order[gesture.slot] !== on) forget();
            if (!gesture) {
                const stride = area.clientWidth + cardGap(area);
                const slot = on === null ? -1 : order.indexOf(on);
                if (stride <= 0 || slot < 0) return;
                gesture = {
                    claimed: claimsWheel(scrollersUnder(event.target), event.deltaX, event.deltaY),
                    stride,
                    slot,
                    raw: 0,
                    offset: 0,
                    toward: null,
                    held: false,
                    frame: null,
                };
            }
            const moving = gesture;
            if (quiet != null) window.clearTimeout(quiet);
            quiet = window.setTimeout(settle, endDelay(fingersDown()));
            if (!moving.claimed) return;
            // Whatever is underneath must not scroll as well, including a terminal
            // that turns wheel gestures into cursor keys.
            event.preventDefault();

            const was = moving.slot;
            const now = panned(moving.raw + event.deltaX / moving.stride, moving.slot, order.length);
            moving.slot = now.slot;
            moving.raw = now.raw;
            moving.offset = now.offset;
            const toward =
                moving.offset > 0 ? (order[moving.slot + 1] ?? null) : moving.offset < 0 ? (order[moving.slot - 1] ?? null) : moving.toward;
            if (moving.slot !== was) cmd.selectWindowId(order[moving.slot]);
            if (!moving.held || moving.slot !== was || toward !== moving.toward) {
                moving.held = true;
                moving.toward = toward;
                latest.current.grab(order[moving.slot], toward);
            }
            if (moving.frame == null) moving.frame = requestAnimationFrame(paint);
        };

        // A hand leaving the trackpad is the end of the swipe, whether or not any
        // more events follow it, so it closes the wait the events were holding open.
        const lifted = onFingersLift(() => {
            if (!gesture || quiet == null) return;
            window.clearTimeout(quiet);
            quiet = window.setTimeout(settle, SPENT_END_MS);
        });
        const watching = new AbortController();
        watchFingers(watching.signal);
        area.addEventListener("wheel", onWheel, { passive: false, capture: true });
        return () => {
            area.removeEventListener("wheel", onWheel, { capture: true });
            watching.abort();
            lifted();
            forget();
        };
    }, [areaRef]);
}

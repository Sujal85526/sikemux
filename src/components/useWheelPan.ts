import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import * as cmd from "../state/commands";
import { panOffset } from "./useWindowPan";
import type { WindowPan } from "./useWindowPan";
import { claimsWheel, dragOffset, GESTURE_END_MS, snapTarget, wheelVelocity } from "./wheelPan";
import type { PaneScroller, WheelSample } from "./wheelPan";

interface Gesture {
    /** Whether the stage took this gesture, decided once on its first event. */
    readonly claimed: boolean;
    /** The screen the gesture started on. If the session leaves it, the gesture is over. */
    readonly window: string;
    readonly slot: number;
    readonly width: number;
    readonly samples: WheelSample[];
    raw: number;
    offset: number;
    toward: string | null;
    started: boolean;
    frame: number | null;
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
 * Drags the track sideways with a two-finger trackpad swipe and settles it on a
 * screen when the fingers stop.
 *
 * The track follows the finger by hand — `--pan` straight onto the element from
 * a frame loop, no React state per frame — and the settle is handed back to
 * `useWindowPan`, so a swipe and a click end the same way.
 */
export function useWheelPan(
    areaRef: RefObject<HTMLElement | null>,
    pan: WindowPan,
    windowIds: readonly string[],
    activeWindowId: string | null,
): void {
    const latest = useRef({ pan, windowIds, activeWindowId });
    latest.current = { pan, windowIds, activeWindowId };

    useEffect(() => {
        const area = areaRef.current;
        if (!area) return;
        let gesture: Gesture | null = null;
        let quiet: number | null = null;

        const forget = () => {
            if (gesture?.frame != null) cancelAnimationFrame(gesture.frame);
            if (quiet != null) window.clearTimeout(quiet);
            gesture = null;
            quiet = null;
        };

        const endsAt = (index: number) => ({ hasPrevious: index > 0, hasNext: index >= 0 && index < latest.current.windowIds.length - 1 });

        const paint = () => {
            const moving = gesture;
            if (!moving) return;
            moving.frame = null;
            if (latest.current.activeWindowId !== moving.window) return;
            latest.current.pan.trackRef.current?.style.setProperty("--pan", panOffset(moving.slot + moving.offset));
        };

        const settle = () => {
            const done = gesture;
            forget();
            if (!done?.claimed) return;
            const { pan: current, windowIds: order } = latest.current;
            const index = order.indexOf(done.window);
            const step = snapTarget(done.offset, wheelVelocity(done.samples), endsAt(index));
            current.release();
            if (step !== 0) cmd.selectWindowId(order[index + step]);
        };

        const onWheel = (event: WheelEvent) => {
            // The strip sits on the stage and scrolls itself.
            if (event.target instanceof Element && event.target.closest(".tabbar")) return;
            const { pan: current, windowIds: order, activeWindowId: active } = latest.current;
            // A switch from somewhere else mid-gesture takes the track away, and
            // there is nothing left for the gesture to drag.
            if (gesture && gesture.window !== active) forget();
            if (!gesture) {
                const width = area.clientWidth;
                const index = active === null ? -1 : order.indexOf(active);
                if (width <= 0 || index < 0 || active === null) return;
                gesture = {
                    claimed: claimsWheel(scrollersUnder(event.target), event.deltaX, event.deltaY),
                    window: active,
                    slot: index,
                    width,
                    samples: [],
                    raw: 0,
                    offset: 0,
                    toward: null,
                    started: false,
                    frame: null,
                };
            }
            const moving = gesture;
            if (quiet != null) window.clearTimeout(quiet);
            quiet = window.setTimeout(settle, GESTURE_END_MS);
            if (!moving.claimed) return;
            // Whatever is underneath must not scroll as well, including a terminal
            // that turns wheel gestures into cursor keys.
            event.preventDefault();

            const delta = event.deltaX / moving.width;
            moving.raw += delta;
            moving.samples.push({ delta, at: event.timeStamp });
            moving.offset = dragOffset(moving.raw, endsAt(moving.slot));
            const toward =
                moving.offset > 0 ? (order[moving.slot + 1] ?? null) : moving.offset < 0 ? (order[moving.slot - 1] ?? null) : moving.toward;
            if (!moving.started || toward !== moving.toward) {
                moving.started = true;
                moving.toward = toward;
                current.drag(moving.window, toward);
            }
            if (moving.frame == null) moving.frame = requestAnimationFrame(paint);
        };

        area.addEventListener("wheel", onWheel, { passive: false, capture: true });
        return () => {
            area.removeEventListener("wheel", onWheel, { capture: true });
            forget();
        };
    }, [areaRef]);
}

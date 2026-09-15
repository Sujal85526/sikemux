import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import * as cmd from "../state/commands";
import { panOffset } from "./useWindowPan";
import type { WindowPan } from "./useWindowPan";
import { claimsWheel, dragOffset, GESTURE_END_MS, snapTarget, wheelVelocity } from "./wheelPan";
import type { PaneScroller, SnapStep, WheelSample } from "./wheelPan";

interface Gesture {
    /** Whether the stage took this gesture, decided once on its first event. */
    readonly claimed: boolean;
    /** The screen the gesture started on. If the session leaves it, the gesture is over. */
    readonly window: string;
    readonly slot: number;
    /** One screen of finger travel in pixels: the stage plus the gap between cards. */
    readonly stride: number;
    readonly samples: WheelSample[];
    raw: number;
    offset: number;
    toward: string | null;
    started: boolean;
    /** Whether the gesture has already landed a screen, which spends it for good. */
    committed: boolean;
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
 * Drags the track sideways with a two-finger trackpad swipe and lands it on a
 * screen the moment the swipe shows which one it wants.
 *
 * The track follows the finger by hand — `--pan` straight onto the element from
 * a frame loop, no React state per frame — and the landing is handed back to
 * `useWindowPan`, so a swipe and a click end the same way.
 *
 * A trackpad keeps sending events after the fingers leave, for a second or more,
 * and nothing in them says the fingers have gone. So the decision cannot wait
 * for the events to stop: it is taken during the swipe, and once taken the rest
 * of the events are swallowed. Only a swipe too small to land anywhere has to
 * wait for quiet, because only then is there nothing to decide.
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

        // Nothing is left to decide here: a swipe that had somewhere to go went
        // there while it was still moving, so quiet can only mean putting it back.
        const settle = () => {
            const done = gesture;
            forget();
            if (!done?.claimed || done.committed) return;
            const { pan: current, activeWindowId: active } = latest.current;
            // A switch from somewhere else already moved the session on, and the
            // pan the gesture was dragging is that switch's slide by now.
            if (active !== done.window) return;
            current.release();
        };

        const rearm = () => {
            if (quiet != null) window.clearTimeout(quiet);
            quiet = window.setTimeout(settle, GESTURE_END_MS);
        };

        /** Lands the screen the swipe asked for, and spends the gesture so its tail asks for nothing. */
        const land = (moving: Gesture, step: SnapStep) => {
            const { pan: current, windowIds: order } = latest.current;
            moving.committed = true;
            if (moving.frame != null) cancelAnimationFrame(moving.frame);
            moving.frame = null;
            current.release();
            cmd.selectWindowId(order[moving.slot + step]);
        };

        const onWheel = (event: WheelEvent) => {
            // The strip sits on the stage and scrolls itself.
            if (event.target instanceof Element && event.target.closest(".tabbar")) return;
            const { pan: current, windowIds: order, activeWindowId: active } = latest.current;
            // The tail of a swipe that already landed. It may not drag the screen
            // it just brought in, but the pane underneath may not scroll on it either.
            if (gesture?.committed) {
                rearm();
                event.preventDefault();
                return;
            }
            // A switch from somewhere else mid-gesture takes the track away, and
            // there is nothing left for the gesture to drag.
            if (gesture && gesture.window !== active) forget();
            if (!gesture) {
                const stride = area.clientWidth + cardGap(area);
                const index = active === null ? -1 : order.indexOf(active);
                if (stride <= 0 || index < 0 || active === null) return;
                gesture = {
                    claimed: claimsWheel(scrollersUnder(event.target), event.deltaX, event.deltaY),
                    window: active,
                    slot: index,
                    stride,
                    samples: [],
                    raw: 0,
                    offset: 0,
                    toward: null,
                    started: false,
                    committed: false,
                    frame: null,
                };
            }
            const moving = gesture;
            rearm();
            if (!moving.claimed) return;
            // Whatever is underneath must not scroll as well, including a terminal
            // that turns wheel gestures into cursor keys.
            event.preventDefault();

            const delta = event.deltaX / moving.stride;
            moving.raw += delta;
            moving.samples.push({ delta, at: event.timeStamp });
            moving.offset = dragOffset(moving.raw, endsAt(moving.slot));
            const toward =
                moving.offset > 0 ? (order[moving.slot + 1] ?? null) : moving.offset < 0 ? (order[moving.slot - 1] ?? null) : moving.toward;
            const handedOver = moving.started && toward === moving.toward;
            if (!handedOver) {
                moving.started = true;
                moving.toward = toward;
                current.drag(moving.window, toward);
            }
            // The handover only reaches the track on the next render, so a swipe
            // cannot land on the very event that asked for the track.
            const step = handedOver ? snapTarget(moving.offset, wheelVelocity(moving.samples), endsAt(moving.slot)) : 0;
            if (step !== 0) {
                land(moving, step);
                return;
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

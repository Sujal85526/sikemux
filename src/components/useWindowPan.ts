import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { performanceTelemetry } from "../lib/performance";

/** How long the track takes to travel one screen. */
export const PAN_MS = 280;
/** Falls back to this when no `transitionend` arrives, so a pan can never get stuck. */
const SETTLE_GUARD_MS = PAN_MS + 120;

interface Pan {
    readonly from: string;
    readonly to: string;
    /** Where the track sits before the slide, in screen widths from its left edge. */
    readonly at: number;
    /** Where the target is parked for the slide, so the travel is one screen however far the jump was. */
    readonly slot: number;
    readonly distance: number;
}

export interface WindowPan {
    readonly trackRef: RefObject<HTMLDivElement | null>;
    readonly panning: boolean;
    /** Whether the track is past its parked position and actually travelling. */
    readonly sliding: boolean;
    /** Where the track sits now, in screen widths from its left edge. */
    readonly at: number;
    /** Where a layer sits now, which is its own slot unless it is the target being parked next door. */
    slotOf(windowId: string, slot: number): number;
    paints(windowId: string): boolean;
}

function reducedMotion(): boolean {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

function planPan(from: string | null, to: string | null, slots: ReadonlyMap<string, number>): Pan | null {
    if (!from || !to || from === to || reducedMotion()) return null;
    const fromSlot = slots.get(from);
    const toSlot = slots.get(to);
    // A window that has left the session has nothing to slide out, so the switch cuts.
    if (fromSlot === undefined || toSlot === undefined) return null;
    return { from, to, at: fromSlot, slot: fromSlot + (toSlot > fromSlot ? 1 : -1), distance: Math.abs(toSlot - fromSlot) };
}

/**
 * Slides the track one screen whenever the session moves to another window.
 *
 * The store has already committed the new active window by the time this runs,
 * so the strip and the keyboard are correct while the slide is still going. A
 * jump of several screens parks its target next to the one being left and puts
 * it back on settle, which keeps the travel and the number of painted layers
 * the same whether the jump was one screen or twenty.
 */
export function useWindowPan(sessionId: string, activeWindowId: string | null, slots: ReadonlyMap<string, number>): WindowPan {
    const trackRef = useRef<HTMLDivElement>(null);
    const [pan, setPan] = useState<Pan | null>(null);
    const [running, setRunning] = useState(false);
    const previous = useRef({ sessionId, activeWindowId });

    if (previous.current.sessionId !== sessionId || previous.current.activeWindowId !== activeWindowId) {
        const was = previous.current;
        previous.current = { sessionId, activeWindowId };
        // Another session is another track, so its switch is not a slide along this one.
        setPan(was.sessionId === sessionId ? planPan(was.activeWindowId, activeWindowId, slots) : null);
        setRunning(false);
    }

    useLayoutEffect(() => {
        if (!pan) return;
        // Reading layout pins the parked position as the value the slide starts from.
        trackRef.current?.getBoundingClientRect();
        setRunning(true);
    }, [pan]);

    useEffect(() => {
        if (!pan || !running) return;
        const track = trackRef.current;
        const span = performanceTelemetry.startTrace("tab-pan", { distance: pan.distance, teleported: pan.distance > 1 });
        const settle = () => setPan(null);
        const guard = window.setTimeout(settle, SETTLE_GUARD_MS);
        const onEnd = (event: TransitionEvent) => {
            if (event.target === track && event.propertyName === "transform") settle();
        };
        track?.addEventListener("transitionend", onEnd);
        return () => {
            window.clearTimeout(guard);
            track?.removeEventListener("transitionend", onEnd);
            const recorded = performanceTelemetry.endSpan(span);
            if (recorded) performanceTelemetry.recordLatency("tab-pan", recorded.durationMs);
        };
    }, [pan, running]);

    return {
        trackRef,
        panning: pan !== null,
        sliding: pan !== null && running,
        at: pan ? (running ? pan.slot : pan.at) : (activeWindowId ? (slots.get(activeWindowId) ?? 0) : 0),
        slotOf: (windowId, slot) => (pan && pan.to === windowId ? pan.slot : slot),
        paints: (windowId) => (pan ? windowId === pan.from || windowId === pan.to : windowId === activeWindowId),
    };
}

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
    /** Where the window being left sits for the whole slide, in screen widths from the track's left edge. */
    readonly fromSlot: number;
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
    /** Where a layer sits now, which is its own slot unless a slide has it parked somewhere else. */
    slotOf(windowId: string, slot: number): number;
    paints(windowId: string): boolean;
}

function reducedMotion(): boolean {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

function planPan(from: string | null, to: string | null, slots: ReadonlyMap<string, number>, running: Pan | null): Pan | null {
    if (!from || !to || from === to || reducedMotion()) return null;
    const home = slots.get(from);
    const toSlot = slots.get(to);
    // A window that has left the session has nothing to slide out, so the switch cuts.
    if (home === undefined || toSlot === undefined) return null;
    // A switch made mid-slide leaves the window the slide was bringing in, which
    // is sitting where that slide parked it rather than on its own screen.
    const fromSlot = running?.to === from ? running.slot : home;
    return { from, to, fromSlot, slot: fromSlot + (toSlot > home ? 1 : -1), distance: Math.abs(toSlot - home) };
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
        const next = was.sessionId === sessionId ? planPan(was.activeWindowId, activeWindowId, slots, pan) : null;
        setPan(next);
        // A slide chaining onto the one already travelling starts from where the
        // track is, so only a fresh one has to park first.
        setRunning(running && next !== null && pan?.to === next.from);
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
        at: pan ? (running ? pan.slot : pan.fromSlot) : (activeWindowId ? (slots.get(activeWindowId) ?? 0) : 0),
        slotOf: (windowId, slot) => {
            if (!pan) return slot;
            if (windowId === pan.to) return pan.slot;
            return windowId === pan.from ? pan.fromSlot : slot;
        },
        paints: (windowId) => (pan ? windowId === pan.from || windowId === pan.to : windowId === activeWindowId),
    };
}

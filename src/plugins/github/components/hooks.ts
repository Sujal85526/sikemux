import { useEffect, useRef, useState } from "react";

/** How coarse a reading has to be before it stops changing every second. */
const MINUTE = 60_000;

/**
 * A clock that only ticks while something on screen is still moving, so a
 * finished run costs nothing and a running one counts up on its own.
 */
export function useNow(live: boolean): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!live) return;
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [live]);
    return now;
}

/**
 * The same clock, rounded to the minute. A row showing "3h ago" re-reads the
 * same string sixty times a minute otherwise, and each reading re-renders it.
 */
export function coarse(now: number): number {
    return Math.floor(now / MINUTE) * MINUTE;
}

/**
 * Calls `work` every `ms` while `live`. The latest `work` is always the one
 * called, and a render in between does not start the wait over, so a view
 * that redraws every second still refreshes on time.
 */
export function useEvery(live: boolean, ms: number, work: () => void): void {
    const latest = useRef(work);
    latest.current = work;
    useEffect(() => {
        if (!live) return;
        const timer = setInterval(() => latest.current(), ms);
        return () => clearInterval(timer);
    }, [live, ms]);
}

import { useEffect, useState } from "react";

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

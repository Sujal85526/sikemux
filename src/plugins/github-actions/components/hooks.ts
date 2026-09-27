import { useEffect, useState } from "react";

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

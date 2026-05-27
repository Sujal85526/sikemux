import { useEffect, useState } from "react";

// A once-per-second ticking clock. Isolated in its own hook so only the
// component that displays time re-renders on each tick.
export function useClock(): Date {
    const [now, setNow] = useState(() => new Date());
    useEffect(() => {
        const id = window.setInterval(() => setNow(new Date()), 1000);
        return () => window.clearInterval(id);
    }, []);
    return now;
}

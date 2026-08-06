import { useEffect, useState } from "react";

export function useClock(): Date {
    const [now, setNow] = useState(() => new Date());
    useEffect(() => {
        let id = 0;
        const tick = () => {
            setNow(new Date());
            const delay = 60_000 - (Date.now() % 60_000) + 20;
            id = window.setTimeout(tick, delay);
        };
        id = window.setTimeout(tick, 60_000 - (Date.now() % 60_000) + 20);
        return () => window.clearTimeout(id);
    }, []);
    return now;
}

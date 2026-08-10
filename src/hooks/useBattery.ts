import { useEffect, useState } from "react";
import { invokeCommand as invoke } from "../api/invoke";
import { swallow } from "../state/toast";

export interface BatteryStatus {
    percent: number | null;
    charging: boolean;
    time_remaining: string | null;
}

const POLL_MS = 30_000;

export function useBattery(): BatteryStatus | null {
    const [status, setStatus] = useState<BatteryStatus | null>(null);
    useEffect(() => {
        let cancelled = false;
        const tick = () => {
            invoke<BatteryStatus>("battery_status")
                .then((s) => {
                    if (!cancelled) setStatus(s);
                })
                .catch(swallow("battery_status poll"));
        };
        tick();
        const id = window.setInterval(tick, POLL_MS);
        return () => {
            cancelled = true;
            window.clearInterval(id);
        };
    }, []);
    return status;
}

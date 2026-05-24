import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface BatteryStatus {
  percent: number | null;
  charging: boolean;
  time_remaining: string | null;
}

// pmset is sub-millisecond on macOS; battery state changes are slow, so a
// 30s poll is plenty (and matches the cadence of the user's tmux-battery).
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
        .catch(() => {});
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

import { useSyncExternalStore } from "react";
import { batteryStatus, subscribeBattery, type BatteryStatus } from "../state/battery";

export type { BatteryStatus };

/** The shared battery reading, polled only while at least one reader is on a visible page. */
export function useBattery(): BatteryStatus | null {
    return useSyncExternalStore(subscribeBattery, batteryStatus, batteryStatus);
}

import { invokeCommand as invoke } from "../api/invoke";
import { swallow } from "./toast";

export interface BatteryStatus {
    percent: number | null;
    charging: boolean;
    time_remaining: string | null;
}

/*
 * Reading this spawns `pmset` in the host process, so there is one poll for the
 * whole app rather than one per reader, and it stops while the window is hidden
 * — a battery reading nobody can see is a subprocess for nothing.
 */
const POLL_MS = 30_000;

let status: BatteryStatus | null = null;
let timer: number | null = null;
let inFlight = false;
const listeners = new Set<() => void>();

function same(a: BatteryStatus | null, b: BatteryStatus): boolean {
    return a !== null && a.percent === b.percent && a.charging === b.charging && a.time_remaining === b.time_remaining;
}

function poll(): void {
    if (inFlight) return;
    inFlight = true;
    void invoke<BatteryStatus>("battery_status")
        .then((next) => {
            if (same(status, next)) return;
            status = next;
            for (const listener of [...listeners]) listener();
        })
        .catch(swallow("battery_status poll"))
        .finally(() => {
            inFlight = false;
        });
}

function sync(): void {
    const wanted = listeners.size > 0 && !document.hidden;
    if (wanted && timer === null) {
        poll();
        timer = window.setInterval(poll, POLL_MS);
    } else if (!wanted && timer !== null) {
        window.clearInterval(timer);
        timer = null;
    }
}

export function subscribeBattery(listener: () => void): () => void {
    listeners.add(listener);
    if (listeners.size === 1) document.addEventListener("visibilitychange", sync);
    sync();
    return () => {
        listeners.delete(listener);
        if (listeners.size === 0) document.removeEventListener("visibilitychange", sync);
        sync();
    };
}

export function batteryStatus(): BatteryStatus | null {
    return status;
}

/**
 * Running off the wall, as far as the last poll knows.
 *
 * A machine with no battery reports no percentage, and is never on battery.
 */
export function onBatteryPower(): boolean {
    return status !== null && status.percent !== null && !status.charging;
}

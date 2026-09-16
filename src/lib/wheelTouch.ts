import { getIpcTransport } from "../api/transport";

/** Named on the Rust side, where the scroll events macOS builds are watched. */
const TOUCH_EVENT = "wheel-touch";

/** Neither, until something reports a hand. Nowhere but macOS ever does. */
let down: boolean | null = null;
const lifts = new Set<() => void>();

/** Whether a hand is on the trackpad, or nothing if nobody is watching for one. */
export const fingersDown = (): boolean | null => down;

/** Runs the moment a hand leaves, which is the only thing that truly ends a swipe. */
export function onFingersLift(listener: () => void): () => void {
    lifts.add(listener);
    return () => void lifts.delete(listener);
}

export function setFingersDown(next: boolean | null): void {
    if (down === next) return;
    down = next;
    if (down === false) for (const listener of [...lifts]) listener();
}

export function watchFingers(signal: AbortSignal): void {
    getIpcTransport()
        .subscribe<boolean>(TOUCH_EVENT, (event) => setFingersDown(event.payload === true), { signal })
        .catch(() => setFingersDown(null));
}

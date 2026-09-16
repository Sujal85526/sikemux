import { getIpcTransport } from "../api/transport";

/** Named on the Rust side, where the scroll events macOS builds are watched. */
const TOUCH_EVENT = "wheel-touch";

let down = false;
const lifts = new Set<() => void>();

/** Whether a hand is on the trackpad. A mouse wheel never touches one, so it is never down. */
export const fingersDown = (): boolean => down;

/** Runs the moment a hand leaves, which is the only thing that truly ends a swipe. */
export function onFingersLift(listener: () => void): () => void {
    lifts.add(listener);
    return () => void lifts.delete(listener);
}

export function setFingersDown(next: boolean): void {
    if (down === next) return;
    down = next;
    if (!down) for (const listener of [...lifts]) listener();
}

/** Nothing is watching until this is called, and then every swipe reads as a mouse wheel. */
export function watchFingers(signal: AbortSignal): void {
    getIpcTransport()
        .subscribe<boolean>(TOUCH_EVENT, (event) => setFingersDown(event.payload === true), { signal })
        .catch(() => setFingersDown(false));
}

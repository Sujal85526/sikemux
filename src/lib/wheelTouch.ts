import { getIpcTransport } from "../api/transport";

/** Named on the Rust side, where the scroll events macOS builds are watched. */
const TOUCH_EVENT = "wheel-touch";

/** Neither, until something reports a hand. Nowhere but macOS ever does. */
let down: boolean | null = null;
const watchers = new Set<(down: boolean) => void>();

/** Whether a hand is on the trackpad, or nothing if nobody is watching for one. */
export const fingersDown = (): boolean | null => down;

/** Runs the moment a hand lands or leaves, which is what starts and ends a swipe. */
export function onFingers(listener: (down: boolean) => void): () => void {
    watchers.add(listener);
    return () => void watchers.delete(listener);
}

export function setFingersDown(next: boolean | null): void {
    if (down === next) return;
    down = next;
    if (down !== null) for (const listener of [...watchers]) listener(down);
}

export function watchFingers(signal: AbortSignal): void {
    getIpcTransport()
        .subscribe<boolean>(TOUCH_EVENT, (event) => setFingersDown(event.payload === true), { signal })
        .catch(() => setFingersDown(null));
}

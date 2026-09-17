import { useEffect, useSyncExternalStore } from "react";

/* Native child views (the browser pages) paint above every DOM element, so an
   overlay that must show over them asks for them to step aside while it is
   open. Depth-counted: overlapping overlays compose and release in any order. */
let depth = 0;
const listeners = new Set<() => void>();

function notify() {
    for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function nativeViewsOccluded(): boolean {
    return depth > 0;
}

export function occludeNativeViews(): () => void {
    depth += 1;
    if (depth === 1) notify();
    let released = false;
    return () => {
        if (released) return;
        released = true;
        depth -= 1;
        if (depth === 0) notify();
    };
}

export function useNativeViewsOccluded(): boolean {
    return useSyncExternalStore(subscribe, nativeViewsOccluded, nativeViewsOccluded);
}

/** Hold the native views aside for as long as `active` stays true. */
export function useOccludeNativeViews(active: boolean): void {
    useEffect(() => {
        if (!active) return;
        return occludeNativeViews();
    }, [active]);
}

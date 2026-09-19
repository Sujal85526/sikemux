import { useSyncExternalStore } from "react";

/* A picture in a transcript is a thumbnail of something worth looking at
   properly. One is open at a time, and the viewer that shows it is mounted at
   the app's root so it covers the window rather than the pane it came from. */
export interface ShownImage {
    /** The data URL the transcript was drawing, which for a big file is a shrunk copy of it. */
    readonly src: string;
    /** What to call it when it is saved. */
    readonly name: string;
    /** The file it came from, when it came from one. */
    readonly path?: string;
}

let shown: ShownImage | null = null;
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

export function shownImage(): ShownImage | null {
    return shown;
}

export function showImage(image: ShownImage): void {
    shown = image;
    notify();
}

export function hideImage(): void {
    if (!shown) return;
    shown = null;
    notify();
}

export function useShownImage(): ShownImage | null {
    return useSyncExternalStore(subscribe, shownImage, shownImage);
}

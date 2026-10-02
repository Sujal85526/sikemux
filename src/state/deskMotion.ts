export const DESK_MOTION_MS = 400;

export type DeskHeading = "open" | "closed";

/* Shares are of the window's width: the desk's when open, and where it is now.
   `appearing` is true for a desk that was not on screen yet, so its fade starts from nothing. */
export type DeskMotion =
    { kind: "moving"; heading: DeskHeading; ms: number; openShare: number; currentShare: number; appearing: boolean } | { kind: "settled" };

type Listener = (event: DeskMotion) => void;

const listeners = new Map<string, Listener>();
const unheard = new Map<string, DeskMotion>();

/** Tell the desk how its split is moving, so it can hold its layout and fade along. */
export function announceDeskMotion(paneId: string, event: DeskMotion): void {
    const listener = listeners.get(paneId);
    if (listener) listener(event);
    else if (event.kind === "moving") unheard.set(paneId, { ...event, appearing: true });
    else unheard.delete(paneId);
}

/** Whether the desk is about to fade in and has not started yet, so whatever it shows should not be drawn. */
export function deskAppearing(paneId: string): boolean {
    const missed = unheard.get(paneId);
    return missed?.kind === "moving" && missed.heading === "open";
}

/* A desk that was just opened mounts a frame after its split starts moving, so it hears the news late. */
export function onDeskMotion(paneId: string, listener: Listener): () => void {
    listeners.set(paneId, listener);
    const missed = unheard.get(paneId);
    if (missed) {
        unheard.delete(paneId);
        listener(missed);
    }
    return () => {
        if (listeners.get(paneId) === listener) listeners.delete(paneId);
    };
}

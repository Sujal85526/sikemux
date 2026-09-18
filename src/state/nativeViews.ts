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

/* A swipe slides the stage sideways by transform, which carries every pane on
   it somewhere else without a scroll or a resize to say so. A native view is
   placed by measuring the DOM, so while the stage moves it has to measure every
   frame, and one loop does that for all of them. */
let moving = false;
let frame = 0;
const watchers = new Set<() => void>();
const followers = new Set<() => void>();

function tick() {
    frame = requestAnimationFrame(tick);
    for (const follower of followers) follower();
}

function watch(watcher: () => void) {
    watchers.add(watcher);
    return () => {
        watchers.delete(watcher);
    };
}

export function stageMoving(): boolean {
    return moving;
}

function setStageMoving(next: boolean) {
    if (moving === next) return;
    moving = next;
    if (next) frame = requestAnimationFrame(tick);
    else {
        cancelAnimationFrame(frame);
        frame = 0;
    }
    for (const watcher of watchers) watcher();
}

export function useStageMoving(): boolean {
    return useSyncExternalStore(watch, stageMoving, stageMoving);
}

/** Say that the stage is travelling for as long as `active` stays true. */
export function useStageMotion(active: boolean): void {
    useEffect(() => {
        setStageMoving(active);
        return () => setStageMoving(false);
    }, [active]);
}

/** Run `follow` on every frame the stage is travelling. */
export function onStageFrame(follow: () => void): () => void {
    followers.add(follow);
    return () => {
        followers.delete(follow);
    };
}

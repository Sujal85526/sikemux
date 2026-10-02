import { useEffect, useSyncExternalStore } from "react";
import { browserApi } from "../api/browser";
import { stageMoving } from "../state/nativeViews";

/*
 * A browser page is a native view, moved by measuring its pane and telling
 * the window where to put it. That always arrives a frame or so after the pane
 * has moved, so while the stage slides the page is drawn as a picture inside
 * its pane instead, and the live page waits under a mask where it will land.
 *
 * The picture has to be ready the moment a swipe starts, so it is retaken
 * while the page sits on screen: shortly after anything about the tab changes,
 * and every few seconds after that.
 */

/** Long enough for a page that just changed to have drawn the change. */
const SETTLE_MS = 300;
const REFRESH_MS = 2000;

interface Still {
    readonly tabId: string;
    readonly url: string;
}

const stills = new Map<string, Still>();
const taking = new Set<string>();
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

async function takeStill(agentId: string, tabId: string): Promise<void> {
    if (taking.has(agentId)) return;
    taking.add(agentId);
    try {
        const jpeg = await browserApi.pageStill(agentId);
        const url = URL.createObjectURL(new Blob([jpeg], { type: "image/jpeg" }));
        const image = new Image();
        image.src = url;
        /* Decoded before it is handed over, so swapping it in never shows a
           half-drawn picture. */
        await image.decode();
        const previous = stills.get(agentId);
        stills.set(agentId, { tabId, url });
        notify();
        /* An image already on screen keeps what it decoded. */
        if (previous) URL.revokeObjectURL(previous.url);
    } catch {
        /* A page that cannot be captured just travels live, as it did before. */
    } finally {
        taking.delete(agentId);
    }
}

/** The picture of `tabId`, once there is one. */
export function usePageStill(agentId: string, tabId: string | undefined): string | null {
    const still = useSyncExternalStore(
        subscribe,
        () => stills.get(agentId),
        () => stills.get(agentId),
    );
    return still && still.tabId === tabId ? still.url : null;
}

/** Keep the picture of a page fresh while the live page is the one on screen. */
export function useStillUpkeep(agentId: string, tabId: string | undefined, onScreen: boolean, version: string): void {
    useEffect(() => {
        if (!onScreen || !tabId) return;
        let timer = 0;
        const take = () => {
            if (!document.hidden && !stageMoving()) void takeStill(agentId, tabId);
            timer = window.setTimeout(take, REFRESH_MS);
        };
        timer = window.setTimeout(take, SETTLE_MS);
        return () => window.clearTimeout(timer);
    }, [agentId, tabId, onScreen, version]);
}

/** Let go of an agent's picture once its desk is gone. */
export function forgetPageStill(agentId: string): void {
    const still = stills.get(agentId);
    if (!still) return;
    stills.delete(agentId);
    URL.revokeObjectURL(still.url);
    notify();
}

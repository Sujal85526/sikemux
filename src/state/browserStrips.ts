import { useEffect } from "react";
import { browserApi, BLANK_URL, type BrowserSnapshot } from "../api/browser";
import { BROWSER_PERSISTENCE_LIMITS } from "../workbench/registry";
import type { BrowserPaneView } from "./types";
import { getState, setState } from "./store";

export const EMPTY_STRIP: BrowserSnapshot = { tabs: [], activeTabId: null };

/*
 * How long a lost tab report can go unnoticed. Tabs push their own changes, so
 * this is only a net under the subscription.
 */
const POLL_MS = 15_000;

/* A loading page reports itself several times over, so a burst collapses into
   the read already in flight plus one after it. */
const rereadWanted = new Map<string, boolean>();

export async function refreshBrowserStrip(agentId: string): Promise<void> {
    if (rereadWanted.has(agentId)) {
        rereadWanted.set(agentId, true);
        return;
    }
    rereadWanted.set(agentId, false);
    try {
        do {
            rereadWanted.set(agentId, false);
            const strip = await browserApi.snapshot(agentId);
            setState((s) => ({ browserStrips: { ...s.browserStrips, [agentId]: strip } }));
        } while (rereadWanted.get(agentId));
    } finally {
        rereadWanted.delete(agentId);
    }
}

/** Whose browsers are on screen, and so worth keeping a strip for. */
function browsingAgentIds(): string[] {
    return [...new Set(Object.values(getState().browserPanes))];
}

/**
 * The app's one reader of the tab strips.
 *
 * A pane draws from these rather than asking for itself, so an agent browsing
 * in a pane nobody is looking at is still the strip that gets saved.
 */
export function useBrowserStrips(): void {
    useEffect(() => {
        const controller = new AbortController();
        const syncAll = () => {
            for (const agentId of browsingAgentIds()) void refreshBrowserStrip(agentId).catch(() => {});
        };
        void browserApi.subscribeTabs(syncAll, controller.signal).catch(() => {});
        const timer = window.setInterval(syncAll, POLL_MS);
        syncAll();
        return () => {
            controller.abort();
            window.clearInterval(timer);
        };
    }, []);
}

/**
 * What to save for a browser pane, or null when there is nothing to come back
 * to. A pane restored but never opened still holds the tabs it was going to
 * open, and those are what carry across a second restart.
 */
export function browserPaneView(paneId: string): BrowserPaneView | null {
    const state = getState();
    const agentId = state.browserPanes[paneId];
    if (!agentId) return null;
    const pending = state.browserRestores[paneId];
    if (pending) return pending;
    const strip = state.browserStrips[agentId] ?? EMPTY_STRIP;
    const saved = strip.tabs.filter((tab) => tab.url && tab.url !== BLANK_URL).slice(0, BROWSER_PERSISTENCE_LIMITS.maxTabs);
    if (saved.length === 0) return null;
    const active = saved.findIndex((tab) => tab.id === strip.activeTabId);
    return {
        agentId,
        tabs: saved.map((tab) => ({ url: tab.url, title: tab.title.slice(0, BROWSER_PERSISTENCE_LIMITS.maxTitleLength) })),
        activeIndex: active < 0 ? 0 : active,
    };
}

/**
 * The tabs a restored pane owes the browser, handed over once. Clearing them
 * as they are taken is what keeps two renders from opening them twice.
 */
export function takeBrowserRestore(paneId: string): BrowserPaneView | null {
    const pending = getState().browserRestores[paneId];
    if (!pending) return null;
    setState((s) => {
        const browserRestores = { ...s.browserRestores };
        delete browserRestores[paneId];
        return { browserRestores };
    });
    return pending;
}

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { browserApi, type BrowserBounds, type BrowserSnapshot } from "../api/browser";
import { onStageFrame, useNativeViewsOccluded, useStageMoving } from "../state/nativeViews";
import type { AgentType } from "../state/types";
import { reportError } from "../state/toast";
import { IconChevron, IconGlobe, IconPlus, IconRefresh } from "./Icons";
import { TabBar } from "./TabBar";
import { useStore } from "../state/store";

const EMPTY_SNAPSHOT: BrowserSnapshot = {
    tabs: [],
    activeTabId: null,
};

const BLANK_URL = "about:blank";

/*
 * How long a lost tab report can go unnoticed.
 *
 * Tabs push their own changes, so this is only a net under the subscription —
 * it used to run every 1.5 seconds, which is an IPC round trip and a React
 * render forty times a minute for a pane that is already being told.
 */
const TAB_POLL_MS = 15_000;

/*
 * Which scrollers can move this pane on screen: its own scrolling ancestors,
 * and the window. Listening on the window in the capture phase instead meant
 * every scroll anywhere in the app — a chat transcript, a terminal, a file tree
 * — asked the browser pane to re-measure itself.
 */
function scrollParents(element: HTMLElement): (HTMLElement | Window)[] {
    const parents: (HTMLElement | Window)[] = [window];
    for (let node = element.parentElement; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (/auto|scroll|overlay/.test(`${style.overflowX} ${style.overflowY}`)) parents.push(node);
    }
    return parents;
}

function sameBounds(a: BrowserBounds | null, b: BrowserBounds): boolean {
    return !!a && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/**
 * A browser pane, as an ordinary leaf in the window layout.
 *
 * It is a sibling of the agent it belongs to rather than something drawn
 * inside it, so it is split, resized, focused and closed by the same layout
 * the terminals use. `browserPanes` is what ties it back to its agent.
 */
export function BrowserPaneHost({ paneId, visible, onEmpty }: { paneId: string; visible: boolean; onEmpty: () => void }) {
    const agentId = useStore((state) => state.browserPanes[paneId]);
    const agentType = useStore((state) => (agentId ? state.agents[agentId]?.type : undefined));
    /* Restored from a layout whose agent is gone — the association is the only
       thing that made this pane mean anything, so it closes. */
    const orphaned = !agentId || !agentType;
    useEffect(() => {
        if (orphaned) onEmpty();
    }, [onEmpty, orphaned]);
    if (orphaned) return null;
    return <BrowserSession key={agentId} agentId={agentId} agentType={agentType} visible={visible} onEmpty={onEmpty} />;
}

function BrowserSession({
    agentId,
    agentType,
    visible,
    onEmpty,
}: {
    agentId: string;
    agentType: AgentType;
    visible: boolean;
    onEmpty: () => void;
}) {
    const [snapshot, setSnapshot] = useState(EMPTY_SNAPSHOT);

    const refresh = useCallback(
        async (signal?: AbortSignal) => {
            const next = await browserApi.snapshot(agentId, signal);
            if (signal?.aborted) return;
            setSnapshot(next);
        },
        [agentId],
    );

    useEffect(() => {
        if (!visible) return;
        const controller = new AbortController();
        let timer = 0;
        let reading = false;
        let again = false;

        /* A loading page reports itself several times over, so a burst
           collapses into the read already in flight plus one after it. */
        const sync = async () => {
            again = true;
            if (reading) return;
            reading = true;
            try {
                while (again && !controller.signal.aborted) {
                    again = false;
                    await refresh(controller.signal);
                }
            } catch (error) {
                if (!controller.signal.aborted) console.warn("browser session read failed", error);
            } finally {
                reading = false;
            }
        };

        /* Tabs announce their own changes; the poll only notices a report
           that was lost while this pane was not listening, which is why it
           reads once on becoming visible and then rarely. */
        const poll = () => {
            void sync();
            timer = window.setTimeout(poll, TAB_POLL_MS);
        };

        void browserApi.subscribeTabs(() => void sync(), controller.signal).catch(() => {});
        poll();
        return () => {
            controller.abort();
            window.clearTimeout(timer);
        };
    }, [refresh, visible]);

    /* The pane exists because a tab does. When the last one goes the pane has
       nothing left to show, so it closes itself rather than sitting empty. */
    useEffect(() => {
        if (!visible || snapshot.tabs.length > 0) return;
        onEmpty();
    }, [onEmpty, snapshot.tabs.length, visible]);

    return <BrowserPane agentId={agentId} agentType={agentType} visible={visible} snapshot={snapshot} refresh={refresh} />;
}

/* The page itself is a native view the window draws over this pane, so the
   pane's only job for it is to say where the page area is. */
function BrowserPane({
    agentId,
    agentType,
    visible,
    snapshot,
    refresh,
}: {
    agentId: string;
    agentType: AgentType;
    visible: boolean;
    snapshot: BrowserSnapshot;
    refresh: (signal?: AbortSignal) => Promise<void>;
}) {
    const viewportRef = useRef<HTMLDivElement>(null);
    const measureRef = useRef<() => void>(() => {});
    const [address, setAddress] = useState("");
    const [placement, setPlacement] = useState<BrowserBounds | null>(null);
    const occluded = useNativeViewsOccluded();
    const moving = useStageMoving();
    const activeTab = useMemo(() => snapshot.tabs.find((tab) => tab.id === snapshot.activeTabId) ?? snapshot.tabs[0], [snapshot]);
    const blank = activeTab?.url === BLANK_URL;
    /* A screen sliding on or off stage is on the window without being the screen
       the session is on, and its page travels with it rather than waiting off
       screen for it to land. */
    const travelling = moving && !!placement && placement.x + placement.width > 0 && placement.x < window.innerWidth;
    const shown = (visible || travelling) && !occluded && !blank && !!activeTab;

    useEffect(() => setAddress(activeTab?.url === BLANK_URL ? "" : (activeTab?.url ?? "")), [activeTab?.id, activeTab?.url]);

    useLayoutEffect(() => {
        const host = viewportRef.current;
        if (!host) return;
        let frame = 0;
        const measure = () => {
            frame = 0;
            const rect = host.getBoundingClientRect();
            const next = {
                x: Math.round(rect.left),
                y: Math.round(rect.top),
                width: Math.max(1, Math.round(rect.width)),
                height: Math.max(1, Math.round(rect.height)),
            };
            setPlacement((previous) => (sameBounds(previous, next) ? previous : next));
        };
        /* Layout settles once per frame; a divider drag fires far more often. */
        const schedule = () => {
            if (!frame) frame = window.requestAnimationFrame(measure);
        };
        measureRef.current = measure;
        measure();
        const observer = new ResizeObserver(schedule);
        observer.observe(host);
        const scrollers = scrollParents(host);
        for (const scroller of scrollers) scroller.addEventListener("scroll", schedule, { passive: true });
        window.addEventListener("resize", schedule);
        window.addEventListener("transitionend", schedule, true);
        return () => {
            observer.disconnect();
            if (frame) window.cancelAnimationFrame(frame);
            for (const scroller of scrollers) scroller.removeEventListener("scroll", schedule);
            window.removeEventListener("resize", schedule);
            window.removeEventListener("transitionend", schedule, true);
        };
    }, []);

    /* Nothing reports the stage sliding the way a scroll or a resize would, so
       the page area is read again on every frame of the travel, and once more
       where it lands. */
    useEffect(() => {
        measureRef.current();
        if (!moving) return;
        return onStageFrame(() => measureRef.current());
    }, [moving]);

    useEffect(() => {
        void browserApi.setBounds(agentId, shown && placement ? placement : null).catch(reportError("place browser page"));
    }, [agentId, placement, shown]);

    useEffect(
        () => () => {
            void browserApi.setBounds(agentId, null).catch(() => {});
        },
        [agentId],
    );

    const run = (operation: Promise<unknown>, label: string) => {
        void operation.then(() => refresh()).catch(reportError(label));
    };

    return (
        <section className={`browser-pane ${agentType}`} data-browser-pane data-agent-id={agentId} aria-label={`${agentType} browser`}>
            <TabBar
                variant="browser"
                ariaLabel="Browser tabs"
                tabs={snapshot.tabs.map((tab) => ({
                    id: tab.id,
                    label: tab.title || (tab.url === BLANK_URL ? "New tab" : tab.url),
                    title: tab.url,
                    active: tab.id === snapshot.activeTabId,
                    icon: <IconGlobe size={13} />,
                    accessory: tab.loading ? (
                        <span className="agent-activity state-working" role="img" aria-label="Loading">
                            <span className="agent-state-loader" aria-hidden="true" />
                        </span>
                    ) : undefined,
                }))}
                onSelect={(id) => run(browserApi.switchTab(agentId, id), "switch browser tab")}
                onClose={(id) => run(browserApi.closeTab(agentId, id), "close browser tab")}
                onAdd={() => run(browserApi.newTab(agentId), "new browser tab")}
                addIcon={<IconPlus size={13} />}
                addTitle="New browser tab — ⌘T"
                addLabel="New browser tab — Command T"
                trailing={<span className="browser-controller">{agentType}</span>}
            />
            <form
                className={`browser-toolbar${activeTab?.loading ? " loading" : ""}`}
                onSubmit={(event) => {
                    event.preventDefault();
                    run(browserApi.navigate(agentId, address), "navigate browser");
                }}>
                <button
                    type="button"
                    aria-label="Back"
                    title="Back — ⌘["
                    disabled={!activeTab?.canGoBack}
                    onClick={() => run(browserApi.back(agentId), "browser back")}>
                    <IconChevron size={13} className="browser-back-icon" />
                </button>
                <button
                    type="button"
                    aria-label="Forward"
                    title="Forward — ⌘]"
                    disabled={!activeTab?.canGoForward}
                    onClick={() => run(browserApi.forward(agentId), "browser forward")}>
                    <IconChevron size={13} />
                </button>
                <button type="button" aria-label="Reload" title="Reload — ⌘R" onClick={() => run(browserApi.reload(agentId), "reload browser")}>
                    <IconRefresh size={13} />
                </button>
                <input
                    className="browser-address"
                    aria-label="Address and search"
                    value={address}
                    placeholder="Search or enter address"
                    spellCheck={false}
                    onFocus={(event) => event.currentTarget.select()}
                    onChange={(event) => setAddress(event.target.value)}
                />
            </form>
            <div ref={viewportRef} className="browser-viewport" tabIndex={-1}>
                {blank && <div className="browser-blank" aria-label="Blank browser page" />}
            </div>
        </section>
    );
}

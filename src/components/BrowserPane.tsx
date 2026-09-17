import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { browserApi, type BrowserBounds, type BrowserSnapshot } from "../api/browser";
import { useNativeViewsOccluded } from "../state/nativeViews";
import type { AgentType } from "../state/types";
import { reportError } from "../state/toast";
import { IconChevron, IconGlobe, IconPlus, IconRefresh } from "./Icons";
import { TabBar } from "./TabBar";

const EMPTY_SNAPSHOT: BrowserSnapshot = {
    tabs: [],
    activeTabId: null,
};

const MIN_SIDE = 320;
const DEFAULT_RATIO = 0.52;
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

export function AgentBrowserShell({
    agentId,
    agentType,
    visible,
    children,
}: {
    agentId: string;
    agentType: AgentType;
    visible: boolean;
    children: ReactNode;
}) {
    const [snapshot, setSnapshot] = useState(EMPTY_SNAPSHOT);
    const [ratio, setRatio] = useState(DEFAULT_RATIO);
    const hostRef = useRef<HTMLDivElement>(null);
    const browserOpen = snapshot.tabs.length > 0;

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

    const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
        const host = hostRef.current;
        if (!host) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        const bounds = host.getBoundingClientRect();
        const move = (next: PointerEvent) => {
            const min = Math.min(0.42, MIN_SIDE / Math.max(bounds.width, 1));
            setRatio(Math.min(1 - min, Math.max(min, (next.clientX - bounds.left) / bounds.width)));
        };
        const stop = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", stop);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", stop, { once: true });
    };

    return (
        <div
            ref={hostRef}
            className={`agent-workspace${browserOpen ? " browser-open" : ""}`}
            style={{ "--agent-side-ratio": ratio } as CSSProperties}>
            <div className="agent-terminal-side">{children}</div>
            {browserOpen && (
                <>
                    <div className="agent-browser-divider" role="separator" aria-orientation="vertical" onPointerDown={startResize} />
                    <BrowserPane agentId={agentId} agentType={agentType} visible={visible} snapshot={snapshot} refresh={refresh} />
                </>
            )}
        </div>
    );
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
    const [address, setAddress] = useState("");
    const [placement, setPlacement] = useState<BrowserBounds | null>(null);
    const occluded = useNativeViewsOccluded();
    const activeTab = useMemo(() => snapshot.tabs.find((tab) => tab.id === snapshot.activeTabId) ?? snapshot.tabs[0], [snapshot]);
    const blank = activeTab?.url === BLANK_URL;
    const shown = visible && !occluded && !blank && !!activeTab;

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
                    icon: <IconGlobe size={17} />,
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

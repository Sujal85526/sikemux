import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { browserApi, type BrowserSnapshot, type BrowserViewport } from "../api/browser";
import type { AgentType } from "../state/types";
import { reportError } from "../state/toast";
import { IconChevron, IconClose, IconPlus, IconRefresh } from "./Icons";

const EMPTY_SNAPSHOT: BrowserSnapshot = {
    tabs: [],
    activeTabId: null,
    frame: null,
    viewportWidth: 1280,
    viewportHeight: 800,
};

const MIN_SIDE = 320;
const DEFAULT_RATIO = 0.52;

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
        async (includeFrame: boolean, viewport?: BrowserViewport, signal?: AbortSignal) => {
            const next = await browserApi.snapshot(agentId, includeFrame, viewport, signal);
            if (!signal?.aborted) {
                setSnapshot((previous) =>
                    includeFrame
                        ? next
                        : {
                              ...next,
                              frame: next.tabs.length > 0 ? previous.frame : null,
                          },
                );
            }
        },
        [agentId],
    );

    useEffect(() => {
        if (!visible) return;
        const controller = new AbortController();
        let timer = 0;
        let stopped = false;
        const poll = async () => {
            try {
                await refresh(false, undefined, controller.signal);
            } catch (error) {
                if (!controller.signal.aborted) console.warn("browser session poll failed", error);
            }
            if (!stopped) timer = window.setTimeout(poll, 700);
        };
        void poll();
        return () => {
            stopped = true;
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
    refresh: (includeFrame: boolean, viewport?: BrowserViewport, signal?: AbortSignal) => Promise<void>;
}) {
    const viewportRef = useRef<HTMLDivElement>(null);
    const addressRef = useRef<HTMLInputElement>(null);
    const [address, setAddress] = useState("");
    const [viewport, setViewport] = useState<BrowserViewport>({ width: 960, height: 640 });
    const lastPointerMove = useRef(0);
    const activeTab = useMemo(() => snapshot.tabs.find((tab) => tab.id === snapshot.activeTabId) ?? snapshot.tabs[0], [snapshot]);
    const blank = activeTab?.url === "about:blank" || activeTab?.url === "chrome://newtab/";

    useEffect(() => setAddress(activeTab?.url === "about:blank" ? "" : (activeTab?.url ?? "")), [activeTab?.id, activeTab?.url]);
    useLayoutEffect(() => {
        const host = viewportRef.current;
        if (!host) return;
        const resize = () => {
            const rect = host.getBoundingClientRect();
            setViewport({ width: Math.max(320, Math.round(rect.width)), height: Math.max(240, Math.round(rect.height)) });
        };
        resize();
        const observer = new ResizeObserver(resize);
        observer.observe(host);
        return () => observer.disconnect();
    }, []);

    useEffect(() => {
        if (!visible) return;
        const controller = new AbortController();
        let timer = 0;
        let stopped = false;
        const draw = async () => {
            try {
                await refresh(!blank, viewport, controller.signal);
            } catch (error) {
                if (!controller.signal.aborted) console.warn("browser frame failed", error);
            }
            if (!stopped) timer = window.setTimeout(draw, 140);
        };
        void draw();
        return () => {
            stopped = true;
            controller.abort();
            window.clearTimeout(timer);
        };
    }, [blank, refresh, viewport, visible]);

    const run = (operation: Promise<unknown>, label: string) => {
        void operation.then(() => refresh(false)).catch(reportError(label));
    };

    const point = (event: React.PointerEvent<HTMLDivElement>) => {
        const rect = event.currentTarget.getBoundingClientRect();
        return {
            x: ((event.clientX - rect.left) / Math.max(rect.width, 1)) * snapshot.viewportWidth,
            y: ((event.clientY - rect.top) / Math.max(rect.height, 1)) * snapshot.viewportHeight,
        };
    };

    const pointer = (event: React.PointerEvent<HTMLDivElement>, kind: "move" | "down" | "up") => {
        if (blank || !snapshot.frame) return;
        if (kind === "move" && performance.now() - lastPointerMove.current < 24) return;
        if (kind === "move") lastPointerMove.current = performance.now();
        const next = point(event);
        if (kind === "down") event.currentTarget.focus();
        const request = browserApi.pointer(agentId, { kind, ...next, button: kind === "move" ? "none" : "left" });
        if (kind === "move") void request.catch(() => {});
        else void request.catch(reportError("browser pointer"));
    };

    return (
        <section className={`browser-pane ${agentType}`} data-browser-pane data-agent-id={agentId} aria-label={`${agentType} browser`}>
            <div className="browser-tabstrip" role="tablist" aria-label="Browser tabs">
                {snapshot.tabs.map((tab) => (
                    <div key={tab.id} className={`browser-tab-wrap${tab.id === snapshot.activeTabId ? " active" : ""}`} role="presentation">
                        <button
                            type="button"
                            role="tab"
                            aria-selected={tab.id === snapshot.activeTabId}
                            className="browser-tab"
                            title={tab.url}
                            onClick={() => run(browserApi.switchTab(agentId, tab.id), "switch browser tab")}>
                            <span className="browser-tab-status" aria-hidden="true" />
                            <span className="browser-tab-title">{tab.title || (tab.url === "about:blank" ? "New tab" : tab.url)}</span>
                        </button>
                        <button
                            type="button"
                            className="browser-tab-close"
                            aria-label={`Close ${tab.title || "tab"}`}
                            onClick={() => run(browserApi.closeTab(agentId, tab.id), "close browser tab")}>
                            <IconClose size={11} />
                        </button>
                    </div>
                ))}
                <button
                    type="button"
                    className="browser-new-tab"
                    aria-label="New browser tab — Command T"
                    title="New browser tab — ⌘T"
                    onClick={() => run(browserApi.newTab(agentId), "new browser tab")}>
                    <IconPlus size={13} />
                </button>
                <span className="browser-controller">{agentType}</span>
            </div>
            <form
                className="browser-toolbar"
                onSubmit={(event) => {
                    event.preventDefault();
                    run(browserApi.navigate(agentId, address), "navigate browser");
                }}>
                <button type="button" aria-label="Back" title="Back — ⌘[" onClick={() => run(browserApi.back(agentId), "browser back")}>
                    <IconChevron size={13} className="browser-back-icon" />
                </button>
                <button type="button" aria-label="Forward" title="Forward — ⌘]" onClick={() => run(browserApi.forward(agentId), "browser forward")}>
                    <IconChevron size={13} />
                </button>
                <button type="button" aria-label="Reload" title="Reload — ⌘R" onClick={() => run(browserApi.reload(agentId), "reload browser")}>
                    <IconRefresh size={13} />
                </button>
                <input
                    ref={addressRef}
                    className="browser-address"
                    aria-label="Address and search"
                    value={address}
                    placeholder="Search or enter address"
                    spellCheck={false}
                    onFocus={(event) => event.currentTarget.select()}
                    onChange={(event) => setAddress(event.target.value)}
                />
            </form>
            <div
                ref={viewportRef}
                className="browser-viewport"
                tabIndex={0}
                onPointerMove={(event) => pointer(event, "move")}
                onPointerDown={(event) => pointer(event, "down")}
                onPointerUp={(event) => pointer(event, "up")}
                onWheel={(event) => {
                    if (blank || !snapshot.frame) return;
                    const next = point(event as unknown as React.PointerEvent<HTMLDivElement>);
                    void browserApi
                        .pointer(agentId, { kind: "wheel", ...next, button: "none", deltaX: event.deltaX, deltaY: event.deltaY })
                        .catch(reportError("scroll browser"));
                }}
                onKeyDown={(event) => {
                    if (event.metaKey || event.ctrlKey || event.altKey) return;
                    event.preventDefault();
                    const text = event.key.length === 1 ? event.key : "";
                    const input = text
                        ? { kind: "text" as const, key: event.key, code: event.code, text }
                        : { kind: "down" as const, key: event.key, code: event.code };
                    void browserApi.key(agentId, input).catch(reportError("type in browser"));
                }}
                onKeyUp={(event) => {
                    if (event.key.length === 1 || event.metaKey || event.ctrlKey || event.altKey) return;
                    event.preventDefault();
                    void browserApi.key(agentId, { kind: "up", key: event.key, code: event.code }).catch(reportError("release browser key"));
                }}>
                {blank ? (
                    <div className="browser-blank" aria-label="Blank browser page" />
                ) : snapshot.frame ? (
                    <img src={`data:image/jpeg;base64,${snapshot.frame}`} draggable={false} alt="" />
                ) : (
                    <div className="browser-loading">
                        <span className="browser-loading-mark" />
                        <span>Opening browser</span>
                    </div>
                )}
            </div>
        </section>
    );
}

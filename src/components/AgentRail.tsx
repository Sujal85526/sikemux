import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AgentInfo, AgentUsage, AgentUsageWindow } from "../api/agents";
import * as cmd from "../state/commands";
import { type ResourceHandle, useResource, useResourceEnabled } from "../state/resources";
import { agentCatalogR, agentSessionsR, agentUsageR } from "../state/resources.defs";
import { useStore } from "../state/store";
import { type Agent, type AgentType } from "../state/types";
import { AgentIcon, IconClock, IconClose, IconPlus, IconRefresh, IconSearch } from "./Icons";
import { AgentStateIndicator } from "./AgentStateIndicator";

const RECENTS_PAGE = 12;
const USAGE_REFRESH_MS = 5 * 60_000;
type UsageAgentType = "claude" | "codex";

function isUsageAgent(type: AgentType | null): type is UsageAgentType {
    return type === "claude" || type === "codex";
}

function ago(unixSecs: number): string {
    if (!unixSecs) return "";
    const d = Math.max(0, Date.now() / 1000 - unixSecs);
    if (d < 90) return "now";
    if (d < 3600) return `${Math.round(d / 60)}m`;
    if (d < 86400) return `${Math.round(d / 3600)}h`;
    return `${Math.round(d / 86400)}d`;
}

const persistedSessionIdOf = (a: Agent) => a.resumeId ?? a.id;
const sessionKey = (type: AgentType, id: string) => `${type}:${id}`;

export function AgentRail() {
    const session = useStore((s) => s.sessions[s.activeSessionId]);
    const activityById = useStore((s) => s.agentActivity);
    const paletteOpen = useStore((s) => s.agentPaletteOpen);
    const density = useStore((s) => s.railDensity);
    const agentsBySession = useStore((s) => s.agentsBySession);
    const agentsById = useStore((s) => s.agents);
    const catalog = useResource(agentCatalogR);
    const availableAgents = useMemo(() => catalog.data ?? [], [catalog.data]);
    const availableTypes = useMemo(() => new Set(availableAgents.map((a) => a.type)), [availableAgents]);
    const claudeDetected = availableTypes.has("claude");
    const codexDetected = availableTypes.has("codex");
    const claudeUsage = useResourceEnabled(claudeDetected, agentUsageR, "claude");
    const codexUsage = useResourceEnabled(codexDetected, agentUsageR, "codex");
    const usageRefreshRef = useRef({ claude: claudeUsage.refresh, codex: codexUsage.refresh });
    usageRefreshRef.current = { claude: claudeUsage.refresh, codex: codexUsage.refresh };

    const [type, setType] = useState<AgentType | null>(null);
    const [visibleRecents, setVisibleRecents] = useState(RECENTS_PAGE);
    // Recent chats live here and nowhere else, so the search for them does too.
    const [query, setQuery] = useState("");
    const [searchOpen, setSearchOpen] = useState(false);
    const searchRef = useRef<HTMLInputElement>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    const selectedType = useMemo(() => {
        if (type && availableAgents.some((a) => a.type === type)) return type;
        return availableAgents[0]?.type ?? null;
    }, [availableAgents, type]);

    useEffect(() => {
        if (selectedType !== type) setType(selectedType);
    }, [selectedType, type]);

    useEffect(() => {
        if (searchOpen) searchRef.current?.focus();
    }, [searchOpen]);

    useEffect(() => {
        if (!claudeDetected && !codexDetected) return;
        const timer = window.setInterval(() => {
            if (claudeDetected) void usageRefreshRef.current.claude();
            if (codexDetected) void usageRefreshRef.current.codex();
        }, USAGE_REFRESH_MS);
        return () => window.clearInterval(timer);
    }, [claudeDetected, codexDetected]);

    const isProject = session?.kind === "project";
    const cwd = session?.cwd ?? "";

    const recents = useResourceEnabled(isProject && !!cwd && selectedType != null, agentSessionsR, selectedType ?? "claude", isProject ? cwd : "");
    const disk = isProject ? (recents.data ?? []) : [];
    const selectedUsage = selectedType === "claude" ? claudeUsage : selectedType === "codex" ? codexUsage : null;
    const usagePeaks = {
        claude: usagePeak(claudeUsage.data),
        codex: usagePeak(codexUsage.data),
    };

    // Reset the reveal window when the recents list switches out from under us.
    useEffect(() => {
        setVisibleRecents(RECENTS_PAGE);
    }, [selectedType, cwd, query]);

    // onRailScroll only reveals more once the list overflows. If the first page
    // doesn't reach the bottom there's no scrollbar, so the rest would never load
    // and the rail sits half-empty. Reveal more until it fills — and re-check when
    // the rail is resized taller.
    useLayoutEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        const fill = () => {
            if (el.scrollHeight <= el.clientHeight && visibleRecents < disk.length) {
                setVisibleRecents((v) => Math.min(v + RECENTS_PAGE, disk.length));
            }
        };
        fill();
        const ro = new ResizeObserver(fill);
        ro.observe(el);
        return () => ro.disconnect();
    }, [visibleRecents, disk.length, cwd, selectedType]);

    if (!session) return null;

    const opens = ((agentsBySession[session.id] ?? []).map((id) => agentsById[id]).filter(Boolean) as Agent[]).filter((a) =>
        availableTypes.has(a.type),
    );

    const activeOpenKeys = new Set(opens.map((a) => sessionKey(a.type, persistedSessionIdOf(a))));
    const needle = query.trim().toLowerCase();
    const recentAll = disk.filter((d) => {
        if (!selectedType) return false;
        if (needle && !d.title.toLowerCase().includes(needle)) return false;
        const k = sessionKey(selectedType, d.id);
        return !activeOpenKeys.has(k);
    });
    const recentDisplay = recentAll.slice(0, visibleRecents);
    const hasMoreRecents = recentDisplay.length < recentAll.length;

    const onRailScroll = () => {
        if (!hasMoreRecents) return;
        const el = scrollRef.current;
        if (!el) return;
        if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) {
            setVisibleRecents((v) => Math.min(v + RECENTS_PAGE, recentAll.length));
        }
    };

    const toggleSearch = () => {
        setQuery("");
        setSearchOpen((open) => !open);
    };

    if (!isProject) {
        return (
            <aside className="agent-rail" data-density={density}>
                <AgentHeader
                    agents={availableAgents}
                    type={selectedType}
                    setType={setType}
                    searchOpen={false}
                    onToggleSearch={toggleSearch}
                    usagePeaks={usagePeaks}
                />
                {isUsageAgent(selectedType) && selectedUsage && (
                    <AgentUsagePanel
                        provider={selectedType}
                        usage={selectedUsage}
                        label={availableAgents.find((a) => a.type === selectedType)?.label}
                    />
                )}
                <div className="agent-empty">agents are project-scoped</div>
            </aside>
        );
    }

    // The unlaunched new-agent page is a draft lane: it owns the selection in
    // the rail until it either starts an agent or is dismissed.
    const draftOpen = paletteOpen && session.view === "agent";
    const noContent = opens.length === 0 && recentDisplay.length === 0 && !draftOpen;

    return (
        <aside className="agent-rail" data-density={density}>
            <AgentHeader
                agents={availableAgents}
                type={selectedType}
                setType={setType}
                searchOpen={searchOpen}
                onToggleSearch={toggleSearch}
                usagePeaks={usagePeaks}
            />
            {isUsageAgent(selectedType) && selectedUsage && (
                <AgentUsagePanel provider={selectedType} usage={selectedUsage} label={availableAgents.find((a) => a.type === selectedType)?.label} />
            )}
            {searchOpen && (
                <div className="rail-search">
                    <IconSearch size={12} />
                    <input
                        ref={searchRef}
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Escape") toggleSearch();
                            e.stopPropagation();
                        }}
                        placeholder="filter recent chats…"
                        aria-label="Filter recent chats"
                        spellCheck={false}
                    />
                </div>
            )}
            <div className="rail-scroll" ref={scrollRef} onScroll={onRailScroll}>
                {draftOpen && (
                    <div className="agent-group">
                        <div className="rail-group-label">Drafting</div>
                        <div className="agent-row-wrap">
                            <button className="agent-row draft active" onClick={cmd.openAgentPalette}>
                                <span className="agent-glyph draft">
                                    <span className="agent-glyph-icon">
                                        <IconPlus size={18} />
                                    </span>
                                </span>
                                <span className="agent-title">New agent</span>
                            </button>
                            <button
                                type="button"
                                className="agent-glyph-x"
                                aria-label="Close new agent"
                                title="Close new agent"
                                onClick={cmd.closeAgentPalette}>
                                <IconClose size={11} />
                            </button>
                        </div>
                    </div>
                )}

                {noContent && (
                    <div className="agent-empty">
                        {catalog.status === "loading"
                            ? "detecting agent CLIs..."
                            : availableAgents.length === 0
                              ? "no agent CLIs detected on PATH"
                              : needle
                                ? "no recent chats match this filter"
                                : "no agents yet — start one above"}
                    </div>
                )}

                {opens.length > 0 && (
                    <div className="agent-group">
                        <div className="rail-group-label">Open</div>
                        {opens.map((a) => {
                            const active = !draftOpen && session.view === "agent" && a.id === session.activeAgentId;
                            return (
                                <div key={a.id} className="agent-row-wrap">
                                    <button className={`agent-row closable${active ? " active" : ""}`} onClick={() => cmd.selectAgent(a.id)}>
                                        <span className={`agent-glyph ${a.type}`}>
                                            <span className="agent-glyph-icon">
                                                <AgentIcon type={a.type} size={20} />
                                            </span>
                                        </span>
                                        <span className="agent-title">{a.title}</span>
                                        {activityById[a.id] && <AgentStateMark state={activityById[a.id].state} />}
                                        {a.launchState === "dormant" && <span className="agent-dormant-label">paused</span>}
                                    </button>
                                    <button
                                        type="button"
                                        className="agent-glyph-x"
                                        aria-label={`Close ${a.title}`}
                                        title={`Close ${a.title}`}
                                        onClick={() => cmd.closeAgent(a.id)}>
                                        <IconClose size={11} />
                                    </button>
                                </div>
                            );
                        })}
                    </div>
                )}

                {selectedType && recentDisplay.length > 0 && (
                    <div className="agent-group">
                        <div className="rail-group-label">Recent</div>
                        {recentDisplay.map((s) => (
                            <button key={s.id} className="agent-row recent" onClick={() => cmd.addAgent(selectedType, s.id, s.title)}>
                                <span className={`agent-glyph ${selectedType}`}>
                                    <AgentIcon type={selectedType} size={20} />
                                </span>
                                <span className="agent-title">{s.title}</span>
                                <span className="agent-ago">{ago(s.mtime)}</span>
                            </button>
                        ))}
                    </div>
                )}
            </div>
        </aside>
    );
}

function AgentStateMark({ state }: { state: import("../state/types").AgentPresentationState }) {
    return <AgentStateIndicator state={state} />;
}

function usagePeak(usage: AgentUsage | undefined): number | undefined {
    if (!usage?.windows.length) return undefined;
    return Math.max(...usage.windows.map((window) => Math.max(0, Math.min(100, window.usedPercent))));
}

function usageTone(percent: number): "steady" | "warm" | "hot" {
    if (percent >= 90) return "hot";
    if (percent >= 70) return "warm";
    return "steady";
}

function resetAtMs(value: AgentUsageWindow["resetsAt"]): number | null {
    if (typeof value === "number") return Number.isFinite(value) ? value * 1000 : null;
    if (typeof value !== "string" || !value) return null;
    if (/^\d+$/.test(value)) return Number(value) * 1000;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
}

function resetCountdown(value: AgentUsageWindow["resetsAt"], now: number): string {
    const reset = resetAtMs(value);
    if (reset == null) return "reset unknown";
    const minutes = Math.max(0, Math.ceil((reset - now) / 60_000));
    if (minutes === 0) return "resetting now";
    if (minutes < 60) return `reset ${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    if (hours < 24) return `reset ${hours}h${remainingMinutes ? ` ${remainingMinutes}m` : ""}`;
    const days = Math.floor(hours / 24);
    const remainingHours = hours % 24;
    if (days < 7) return `reset ${days}d${remainingHours ? ` ${remainingHours}h` : ""}`;
    return `reset ${new Date(reset).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

function resetTitle(value: AgentUsageWindow["resetsAt"]): string {
    const reset = resetAtMs(value);
    return reset == null ? "Reset time unavailable" : `Resets ${new Date(reset).toLocaleString()}`;
}

function planLabel(plan: string | null | undefined): string {
    if (!plan) return "account";
    return plan
        .split(/[_-]/g)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
}

function AgentUsagePanel({ provider, usage, label }: { provider: UsageAgentType; usage: ResourceHandle<AgentUsage>; label?: string }) {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), 60_000);
        return () => window.clearInterval(timer);
    }, []);

    const providerLabel = label ?? (provider === "claude" ? "Claude" : "Codex");
    const windows = usage.data?.windows ?? [];
    const emptyCopy =
        usage.status === "loading" ? "reading plan limits…" : usage.status === "error" ? "plan limits unavailable" : "no plan limits reported";

    return (
        <section className={`agent-usage-panel ${provider}`} aria-label={`${providerLabel} plan limits`}>
            <div className="agent-usage-head">
                <span className={`agent-usage-provider ${provider}`}>
                    <AgentIcon type={provider} size={14} />
                    <span>
                        <strong>{providerLabel}</strong>
                        <small>plan capacity</small>
                    </span>
                </span>
                {usage.data && <span className="agent-usage-plan">{planLabel(usage.data.plan)}</span>}
                <button
                    type="button"
                    className="agent-usage-refresh"
                    aria-label={`Refresh ${providerLabel} plan limits`}
                    title={`Refresh ${providerLabel} plan limits`}
                    disabled={usage.status === "loading"}
                    onClick={() => void usage.refresh()}>
                    <IconRefresh size={12} />
                </button>
            </div>

            {windows.length > 0 ? (
                <div className="agent-usage-grid" data-single={windows.length === 1 ? "true" : "false"}>
                    {windows.map((window, index) => {
                        const percent = Math.max(0, Math.min(100, window.usedPercent));
                        const tone = usageTone(percent);
                        const countdown = resetCountdown(window.resetsAt, now);
                        return (
                            <div
                                className="agent-usage-window"
                                data-tone={tone}
                                key={`${window.label}:${String(window.resetsAt)}:${index}`}
                                title={`${window.label}: ${Math.round(percent)}% used. ${resetTitle(window.resetsAt)}`}>
                                <div className="agent-usage-window-head">
                                    <span>{window.label}</span>
                                    <strong>{Math.round(percent)}%</strong>
                                </div>
                                <div
                                    className="agent-usage-meter"
                                    role="meter"
                                    aria-label={`${window.label} usage`}
                                    aria-valuemin={0}
                                    aria-valuemax={100}
                                    aria-valuenow={Math.round(percent)}>
                                    <span style={{ width: `${percent}%` }} />
                                </div>
                                <span className="agent-usage-reset">
                                    <IconClock size={9} />
                                    {countdown}
                                </span>
                            </div>
                        );
                    })}
                </div>
            ) : (
                <div className="agent-usage-empty" data-loading={usage.status === "loading" ? "true" : "false"}>
                    <span />
                    {emptyCopy}
                </div>
            )}
        </section>
    );
}

function AgentHeader({
    agents,
    type,
    setType,
    searchOpen,
    onToggleSearch,
    usagePeaks,
}: {
    agents: AgentInfo[];
    type: AgentType | null;
    setType: (t: AgentType) => void;
    searchOpen: boolean;
    onToggleSearch: () => void;
    usagePeaks: Partial<Record<UsageAgentType, number | undefined>>;
}) {
    const label = agents.find((a) => a.type === type)?.label ?? type;
    return (
        <div className="agent-header">
            <div className="agent-header-types">
                {agents.map((a) => (
                    <button
                        key={a.type}
                        className={`agent-header-btn ${a.type}${type === a.type ? " active" : ""}`}
                        title={
                            isUsageAgent(a.type) && usagePeaks[a.type] != null
                                ? `${a.label} — ${Math.round(usagePeaks[a.type]!)}% of the busiest limit used`
                                : a.label
                        }
                        onClick={() => setType(a.type)}>
                        <AgentIcon type={a.type} size={18} />
                        {isUsageAgent(a.type) && usagePeaks[a.type] != null && (
                            <span className="agent-header-capacity" data-tone={usageTone(usagePeaks[a.type]!)} aria-hidden="true">
                                <span style={{ width: `${Math.max(0, Math.min(100, usagePeaks[a.type]!))}%` }} />
                            </span>
                        )}
                    </button>
                ))}
            </div>
            <div className="agent-header-actions">
                <button
                    className={`agent-header-btn${searchOpen ? " active" : ""}`}
                    aria-pressed={searchOpen}
                    title="Filter recent chats"
                    onClick={onToggleSearch}>
                    <IconSearch size={15} />
                </button>
                <button
                    className="agent-header-btn"
                    disabled={!type}
                    title={type ? `new ${label} agent — ⌥N` : "No agent CLI detected"}
                    onClick={() => {
                        if (type) cmd.openAgentPalette();
                    }}>
                    <IconPlus size={15} />
                </button>
            </div>
        </div>
    );
}

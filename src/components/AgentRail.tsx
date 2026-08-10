import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AgentInfo } from "../api/agents";
import * as cmd from "../state/commands";
import { useResource, useResourceEnabled } from "../state/resources";
import { agentCatalogR, agentSessionsR } from "../state/resources.defs";
import { useStore } from "../state/store";
import { type Agent, type AgentType } from "../state/types";
import { AgentIcon, IconClose, IconPlus, IconSearch } from "./Icons";
import { AgentStateIndicator } from "./AgentStateIndicator";

const RECENTS_PAGE = 12;

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

    const isProject = session?.kind === "project";
    const cwd = session?.cwd ?? "";

    const recents = useResourceEnabled(isProject && !!cwd && selectedType != null, agentSessionsR, selectedType ?? "claude", isProject ? cwd : "");
    const disk = isProject ? (recents.data ?? []) : [];

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
                <AgentHeader agents={availableAgents} type={selectedType} setType={setType} searchOpen={false} onToggleSearch={toggleSearch} />
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
            <AgentHeader agents={availableAgents} type={selectedType} setType={setType} searchOpen={searchOpen} onToggleSearch={toggleSearch} />
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

function AgentHeader({
    agents,
    type,
    setType,
    searchOpen,
    onToggleSearch,
}: {
    agents: AgentInfo[];
    type: AgentType | null;
    setType: (t: AgentType) => void;
    searchOpen: boolean;
    onToggleSearch: () => void;
}) {
    const label = agents.find((a) => a.type === type)?.label ?? type;
    return (
        <div className="agent-header">
            <div className="agent-header-types">
                {agents.map((a) => (
                    <button
                        key={a.type}
                        className={`agent-header-btn${type === a.type ? " active" : ""}`}
                        title={a.label}
                        onClick={() => setType(a.type)}>
                        <AgentIcon type={a.type} size={18} />
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

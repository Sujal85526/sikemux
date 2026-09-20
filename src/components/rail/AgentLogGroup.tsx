import { useEffect, useRef } from "react";
import * as cmd from "../../state/commands";
import type { Agent, Session } from "../../state/types";
import type { PastChat } from "../../hooks/useAgentLog";
import { activeAgentId } from "../../state/selectors";
import { useStore } from "../../state/store";
import { AgentIcon, IconClose, IconPlus, IconSearch } from "../Icons";
import { AgentStateIndicator } from "../AgentStateIndicator";
import { Tooltip } from "../Tooltip";
import { Panel, PanelHeader } from "../Panel";

function ago(unixSecs: number): string {
    if (!unixSecs) return "";
    const d = Math.max(0, Date.now() / 1000 - unixSecs);
    if (d < 90) return "now";
    if (d < 3600) return `${Math.round(d / 60)}m`;
    if (d < 86400) return `${Math.round(d / 3600)}h`;
    return `${Math.round(d / 86400)}d`;
}

/**
 * Every chat this project has, as one run of rows.
 *
 * There is no Open heading and no Recent heading: a live chat is at full ink
 * with its state mark and a close, a past one steps back and carries a time
 * instead. Weight does what two labelled sections used to, which is most of why
 * this fits under the tree at all.
 *
 * No provider switch either — every row wears its own provider and the list is
 * one list, newest first. You look for a chat by its title.
 */
export function AgentLogGroup({
    session,
    open,
    past,
    shown,
    query,
    filterOpen,
    loading,
    onMore,
    onQuery,
    onToggleFilter,
    onSelect,
    onResume,
    onNew,
}: {
    session: Session;
    open: Agent[];
    past: PastChat[];
    shown: number;
    query: string;
    filterOpen: boolean;
    loading: boolean;
    onMore: () => void;
    onQuery: (value: string) => void;
    onToggleFilter: () => void;
    onSelect: (agentId: string) => void;
    onResume: (chat: PastChat) => void;
    onNew: () => void;
}) {
    const windowsById = useStore((s) => s.windows);
    const activityById = useStore((s) => s.agentActivity);
    const backgroundById = useStore((s) => s.agentBackgroundWork);
    const searchRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (filterOpen) searchRef.current?.focus();
    }, [filterOpen]);

    const needle = query.trim().toLowerCase();
    const matches = (title: string) => !needle || title.toLowerCase().includes(needle);
    const liveRows = open.filter((agent) => matches(agent.title));
    const pastRows = past.filter((chat) => matches(chat.title));
    const visiblePast = pastRows.slice(0, shown);
    const current = activeAgentId({ windows: windowsById }, session);

    const actions = (
        <span className="rail-group-actions">
            <Tooltip label="Filter chats">
                <button
                    type="button"
                    className={`rail-group-add${filterOpen ? " on" : ""}`}
                    aria-pressed={filterOpen}
                    aria-label="Filter chats"
                    onClick={onToggleFilter}>
                    <IconSearch size={11} />
                </button>
            </Tooltip>
            <Tooltip label="New agent — ⌥N">
                <button type="button" className="rail-group-add" aria-label="New agent" onClick={onNew}>
                    <IconPlus size={11} />
                </button>
            </Tooltip>
        </span>
    );

    return (
        <Panel variant="group" className="agent-group">
            <PanelHeader label="Agents" rule extra={actions} />
            {filterOpen && (
                <div className="rail-find">
                    <IconSearch size={12} />
                    <input
                        ref={searchRef}
                        value={query}
                        onChange={(event) => onQuery(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Escape") onToggleFilter();
                            event.stopPropagation();
                        }}
                        placeholder="filter chats"
                        aria-label="Filter chats"
                        spellCheck={false}
                    />
                </div>
            )}

            {liveRows.map((agent) => (
                <div key={agent.id} className="agent-row-wrap">
                    <button className={`agent-row${current === agent.id ? " active" : ""}`} onClick={() => onSelect(agent.id)}>
                        <span className={`agent-glyph ${agent.type}`}>
                            <AgentIcon type={agent.type} size={20} />
                        </span>
                        <span className="agent-title">{agent.title}</span>
                    </button>
                    {(activityById[agent.id] || (backgroundById[agent.id] ?? 0) > 0) && (
                        <span className="row-status">
                            <AgentStateIndicator state={activityById[agent.id]?.state ?? "idle"} background={(backgroundById[agent.id] ?? 0) > 0} />
                        </span>
                    )}
                    <Tooltip label={`Close ${agent.title}`}>
                        <button type="button" className="row-x" aria-label={`Close ${agent.title}`} onClick={() => cmd.closeAgent(agent.id)}>
                            <IconClose size={11} />
                        </button>
                    </Tooltip>
                </div>
            ))}

            {visiblePast.map((chat) => (
                <button key={`${chat.type}:${chat.id}`} className="agent-row recent" onClick={() => onResume(chat)}>
                    <span className={`agent-glyph ${chat.type}`}>
                        <AgentIcon type={chat.type} size={20} />
                    </span>
                    <span className="agent-title">{chat.title}</span>
                    <span className="agent-ago">{ago(chat.mtime)}</span>
                </button>
            ))}

            {pastRows.length > visiblePast.length && (
                <button type="button" className="log-more" onClick={onMore}>
                    {pastRows.length - visiblePast.length} older
                </button>
            )}

            {liveRows.length === 0 && visiblePast.length === 0 && (
                <div className="log-empty">
                    {loading ? "reading this project's chats…" : needle ? "nothing matches that" : "no chats in this project yet"}
                </div>
            )}
        </Panel>
    );
}

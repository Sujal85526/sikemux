import { useState } from "react";
import * as cmd from "../state/commands";
import { useResourceEnabled } from "../state/resources";
import { agentSessionsR } from "../state/resources.defs";
import { useStore } from "../state/store";
import { AGENT_TYPES, type Agent, type AgentType } from "../state/types";
import { AgentIcon, IconClose, IconPin, IconPlus, IconSearch } from "./Icons";

const RECENTS_CAP = 10;

function ago(unixSecs: number): string {
    if (!unixSecs) return "";
    const d = Math.max(0, Date.now() / 1000 - unixSecs);
    if (d < 90) return "now";
    if (d < 3600) return `${Math.round(d / 60)}m`;
    if (d < 86400) return `${Math.round(d / 3600)}h`;
    return `${Math.round(d / 86400)}d`;
}

const bmIdOf = (a: Agent) => a.resumeId ?? a.id;
const sessionKey = (type: AgentType, id: string) => `${type}:${id}`;

export function AgentRail() {
    const session = useStore((s) => s.sessions[s.activeSessionId]);
    const sessionsById = useStore((s) => s.sessions);
    const sessionOrder = useStore((s) => s.sessionOrder);
    const agentsBySession = useStore((s) => s.agentsBySession);
    const agentsById = useStore((s) => s.agents);
    const agentBookmarks = useStore((s) => s.agentBookmarks);

    const [type, setType] = useState<AgentType>("claude");

    const isProject = session?.kind === "project";
    const cwd = session?.cwd ?? "";

    // Disk-scanned recent agent sessions for this project + type. Hooks
    // mounted unconditionally; we just ignore the fetch when not project.
    const recents = useResourceEnabled(isProject && !!cwd, agentSessionsR, type, isProject ? cwd : "");
    const disk = isProject ? (recents.data ?? []) : [];

    if (!session) return null;

    const opens = (agentsBySession[session.id] ?? []).map((id) => agentsById[id]).filter(Boolean) as Agent[];

    const pinnedKeys = new Set(agentBookmarks.map((b) => sessionKey(b.type, b.id)));
    const activeOpenKeys = new Set(opens.map((a) => sessionKey(a.type, bmIdOf(a))));
    // Cross-session lookup — a pinned bookmark gets a live dot if its session
    // is running in ANY project.
    const liveByKey = new Map<string, string>();
    sessionOrder.forEach((id) => {
        const s = sessionsById[id];
        if (s?.kind === "project") {
            const aids = agentsBySession[id] ?? [];
            for (const aid of aids) {
                const a = agentsById[aid];
                if (a) liveByKey.set(sessionKey(a.type, bmIdOf(a)), a.id);
            }
        }
    });

    const pinnedDisplay = agentBookmarks;
    const openDisplay = opens.filter((a) => !pinnedKeys.has(sessionKey(a.type, bmIdOf(a))));
    const recentDisplay = disk
        .filter((d) => {
            const k = sessionKey(type, d.id);
            return !pinnedKeys.has(k) && !activeOpenKeys.has(k);
        })
        .slice(0, RECENTS_CAP);

    if (!isProject) {
        return (
            <aside className="agent-rail">
                <AgentHeader type={type} setType={setType} />
                <div className="agent-empty">agents are project-scoped</div>
            </aside>
        );
    }

    const noContent = pinnedDisplay.length === 0 && openDisplay.length === 0 && recentDisplay.length === 0;

    return (
        <aside className="agent-rail">
            <AgentHeader type={type} setType={setType} />
            <div className="rail-scroll">
                {noContent && <div className="agent-empty">no agents yet — start one above</div>}

                {pinnedDisplay.length > 0 && (
                    <div className="agent-group">
                        <div className="rail-group-label">Pinned</div>
                        {pinnedDisplay.map((b) => {
                            const liveAgentId = liveByKey.get(sessionKey(b.type, b.id));
                            return (
                                <button
                                    key={`bm-${b.type}-${b.id}`}
                                    className={`agent-row${liveAgentId ? " closable" : ""}`}
                                    onClick={() => cmd.openAgentBookmark(b)}>
                                    <span className={`agent-glyph ${b.type}`}>
                                        <span className="agent-glyph-icon">
                                            <AgentIcon type={b.type} size={16} />
                                        </span>
                                        {liveAgentId && (
                                            <span
                                                className="agent-glyph-x"
                                                title="Close agent"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    cmd.closeAgent(liveAgentId);
                                                }}>
                                                <IconClose size={11} />
                                            </span>
                                        )}
                                    </span>
                                    <span className="agent-title">{b.title}</span>
                                    {liveAgentId && <span className="live-dot" title="running" />}
                                    <span
                                        className="agent-bm on"
                                        title="Unpin"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            cmd.toggleAgentBookmark(b);
                                        }}>
                                        <IconPin size={12} filled />
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                )}

                {openDisplay.length > 0 && (
                    <div className="agent-group">
                        <div className="rail-group-label">Open</div>
                        {openDisplay.map((a) => {
                            const active = session.view === "agent" && a.id === session.activeAgentId;
                            const bmId = bmIdOf(a);
                            return (
                                <button key={a.id} className={`agent-row closable${active ? " active" : ""}`} onClick={() => cmd.selectAgent(a.id)}>
                                    <span className={`agent-glyph ${a.type}`}>
                                        <span className="agent-glyph-icon">
                                            <AgentIcon type={a.type} size={16} />
                                        </span>
                                        <span
                                            className="agent-glyph-x"
                                            title="Close agent"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                cmd.closeAgent(a.id);
                                            }}>
                                            <IconClose size={11} />
                                        </span>
                                    </span>
                                    <span className="agent-title">{a.title}</span>
                                    <span
                                        className="agent-bm"
                                        title="Pin"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            cmd.toggleAgentBookmark({
                                                type: a.type,
                                                id: bmId,
                                                title: a.title,
                                                cwd: session.cwd,
                                            });
                                        }}>
                                        <IconPin size={12} />
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                )}

                {recentDisplay.length > 0 && (
                    <div className="agent-group">
                        <div className="rail-group-label">Recent</div>
                        {recentDisplay.map((s) => (
                            <button key={s.id} className="agent-row recent" onClick={() => cmd.addAgent(type, s.id, s.title)}>
                                <span className={`agent-glyph ${type} dim`}>
                                    <AgentIcon type={type} size={16} />
                                </span>
                                <span className="agent-title">{s.title}</span>
                                <span
                                    className="agent-bm"
                                    title="Pin"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        cmd.toggleAgentBookmark({
                                            type,
                                            id: s.id,
                                            title: s.title,
                                            cwd: session.cwd,
                                        });
                                    }}>
                                    <IconPin size={12} />
                                </span>
                                <span className="agent-ago">{ago(s.mtime)}</span>
                            </button>
                        ))}
                    </div>
                )}
            </div>
        </aside>
    );
}

function AgentHeader({ type, setType }: { type: AgentType; setType: (t: AgentType) => void }) {
    return (
        <div className="agent-header">
            <div className="agent-header-types">
                {AGENT_TYPES.map((t) => (
                    <button key={t} className={`agent-header-btn${type === t ? " active" : ""}`} title={t} onClick={() => setType(t)}>
                        <AgentIcon type={t} size={16} />
                    </button>
                ))}
            </div>
            <div className="agent-header-actions">
                <button className="agent-header-btn" title="Search agent sessions" onClick={cmd.openAgentPalette}>
                    <IconSearch size={15} />
                </button>
                <button className="agent-header-btn" title={`new ${type} agent`} onClick={() => cmd.addAgent(type)}>
                    <IconPlus size={15} />
                </button>
            </div>
        </div>
    );
}

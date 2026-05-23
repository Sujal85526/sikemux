import { useEffect, useState } from "react";
import { agentApi, type AgentSession } from "../api/agents";
import {
  AGENT_TYPES,
  type Agent,
  type AgentType,
} from "../state/types";
import { useWorkspace } from "../state/workspace";
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

// A resumed agent's bookmark id is its on-disk session id; a fresh agent
// falls back to its sikemux id (no on-disk session to point at yet).
const bmIdOf = (a: Agent) => a.resumeId ?? a.id;
const sessionKey = (type: AgentType, id: string) => `${type}:${id}`;

export function AgentRail() {
  const session = useWorkspace(
    (s) => s.sessions.find((x) => x.id === s.activeSessionId)!,
  );
  const allSessions = useWorkspace((s) => s.sessions);
  const addAgent = useWorkspace((s) => s.addAgent);
  const selectAgent = useWorkspace((s) => s.selectAgent);
  const closeAgent = useWorkspace((s) => s.closeAgent);
  const agentBookmarks = useWorkspace((s) => s.agentBookmarks);
  const toggleAgentBookmark = useWorkspace((s) => s.toggleAgentBookmark);
  const openAgentBookmark = useWorkspace((s) => s.openAgentBookmark);
  const openAgentPalette = useWorkspace((s) => s.openAgentPalette);

  const [type, setType] = useState<AgentType>("claude");
  const [disk, setDisk] = useState<AgentSession[]>([]);

  const isProject = session.kind === "project";
  const cwd = session.cwd;

  useEffect(() => {
    if (!isProject || !cwd) {
      setDisk([]);
      return;
    }
    let cancelled = false;
    agentApi
      .sessions(type, cwd)
      .then((d) => !cancelled && setDisk(d))
      .catch(() => !cancelled && setDisk([]));
    return () => {
      cancelled = true;
    };
  }, [type, cwd, isProject]);

  // Dedup priority: pinned > open > recent. Each session shown in one place.
  const opens = session.agents;
  const pinnedKeys = new Set(
    agentBookmarks.map((b) => sessionKey(b.type, b.id)),
  );
  const activeOpenKeys = new Set(
    opens.map((a) => sessionKey(a.type, bmIdOf(a))),
  );
  // Cross-session lookup — a pinned bookmark gets a live dot if its session
  // is running in ANY project (not just the active one). Value = agent id,
  // so the row can close it without needing to switch projects first.
  const liveByKey = new Map<string, string>();
  allSessions.forEach((s) => {
    if (s.kind === "project") {
      s.agents.forEach((a) => {
        liveByKey.set(sessionKey(a.type, bmIdOf(a)), a.id);
      });
    }
  });

  const pinnedDisplay = agentBookmarks;
  const openDisplay = opens.filter(
    (a) => !pinnedKeys.has(sessionKey(a.type, bmIdOf(a))),
  );
  const recentDisplay = disk
    .filter((d) => {
      const k = sessionKey(type, d.id);
      return !pinnedKeys.has(k) && !activeOpenKeys.has(k);
    })
    .slice(0, RECENTS_CAP);

  if (!isProject) {
    return (
      <aside className="agent-rail">
        <div className="agent-empty">agents are project-scoped</div>
        <AgentFooter
          type={type}
          setType={setType}
          addAgent={addAgent}
          openPalette={openAgentPalette}
        />
      </aside>
    );
  }

  const noContent =
    pinnedDisplay.length === 0 &&
    openDisplay.length === 0 &&
    recentDisplay.length === 0;

  return (
    <aside className="agent-rail">
      <div className="rail-scroll">
        {noContent && (
          <div className="agent-empty">no agents yet — start one below</div>
        )}

        {pinnedDisplay.length > 0 && (
          <div className="agent-group">
            <div className="rail-group-label">Pinned</div>
            {pinnedDisplay.map((b) => {
              const liveAgentId = liveByKey.get(sessionKey(b.type, b.id));
              return (
                <button
                  key={`bm-${b.type}-${b.id}`}
                  className={`agent-row${liveAgentId ? " closable" : ""}`}
                  onClick={() => openAgentBookmark(b)}
                >
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
                          closeAgent(liveAgentId);
                        }}
                      >
                        <IconClose size={11} />
                      </span>
                    )}
                  </span>
                  <span className="agent-title">{b.title}</span>
                  {liveAgentId && (
                    <span className="live-dot" title="running" />
                  )}
                  <span
                    className="agent-bm on"
                    title="Unpin"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleAgentBookmark(b);
                    }}
                  >
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
              const active =
                session.view === "agent" && a.id === session.activeAgentId;
              const bmId = bmIdOf(a);
              return (
                <button
                  key={a.id}
                  className={`agent-row closable${active ? " active" : ""}`}
                  onClick={() => selectAgent(a.id)}
                >
                  <span className={`agent-glyph ${a.type}`}>
                    <span className="agent-glyph-icon">
                      <AgentIcon type={a.type} size={16} />
                    </span>
                    <span
                      className="agent-glyph-x"
                      title="Close agent"
                      onClick={(e) => {
                        e.stopPropagation();
                        closeAgent(a.id);
                      }}
                    >
                      <IconClose size={11} />
                    </span>
                  </span>
                  <span className="agent-title">{a.title}</span>
                  <span
                    className="agent-bm"
                    title="Pin"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleAgentBookmark({
                        type: a.type,
                        id: bmId,
                        title: a.title,
                        cwd: session.cwd,
                      });
                    }}
                  >
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
              <button
                key={s.id}
                className="agent-row recent"
                onClick={() => addAgent(type, s.id, s.title)}
              >
                <span className={`agent-glyph ${type} dim`}>
                  <AgentIcon type={type} size={16} />
                </span>
                <span className="agent-title">{s.title}</span>
                <span
                  className="agent-bm"
                  title="Pin"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleAgentBookmark({
                      type,
                      id: s.id,
                      title: s.title,
                      cwd: session.cwd,
                    });
                  }}
                >
                  <IconPin size={12} />
                </span>
                <span className="agent-ago">{ago(s.mtime)}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <AgentFooter
        type={type}
        setType={setType}
        addAgent={addAgent}
        openPalette={openAgentPalette}
      />
    </aside>
  );
}

function AgentFooter({
  type,
  setType,
  addAgent,
  openPalette,
}: {
  type: AgentType;
  setType: (t: AgentType) => void;
  addAgent: (t: AgentType) => void;
  openPalette: () => void;
}) {
  return (
    <div className="agent-footer">
      <div className="agent-footer-types">
        {AGENT_TYPES.map((t) => (
          <button
            key={t}
            className={`agent-footer-btn${type === t ? " active" : ""}`}
            title={t}
            onClick={() => setType(t)}
          >
            <AgentIcon type={t} size={16} />
          </button>
        ))}
      </div>
      <div className="agent-footer-actions">
        <button
          className="agent-footer-btn"
          title="Search agent sessions"
          onClick={openPalette}
        >
          <IconSearch size={15} />
        </button>
        <button
          className="agent-footer-btn"
          title={`new ${type} agent`}
          onClick={() => addAgent(type)}
        >
          <IconPlus size={15} />
        </button>
      </div>
    </div>
  );
}

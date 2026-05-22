import { useEffect, useState } from "react";
import { agentApi, type AgentSession } from "../api/agents";
import {
  AGENT_TYPES,
  type Agent,
  type AgentBookmark,
  type AgentType,
} from "../state/types";
import { useWorkspace } from "../state/workspace";
import { AgentIcon, IconClose, IconPin, IconPlus, IconSearch } from "./Icons";

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

// The right rail — bookmarks, open agents, then a type picker over sessions.
export function AgentRail() {
  const session = useWorkspace(
    (s) => s.sessions.find((x) => x.id === s.activeSessionId)!,
  );
  const addAgent = useWorkspace((s) => s.addAgent);
  const selectAgent = useWorkspace((s) => s.selectAgent);
  const closeAgent = useWorkspace((s) => s.closeAgent);
  const agentBookmarks = useWorkspace((s) => s.agentBookmarks);
  const toggleAgentBookmark = useWorkspace((s) => s.toggleAgentBookmark);
  const openAgentPalette = useWorkspace((s) => s.openAgentPalette);

  const [type, setType] = useState<AgentType>("claude");
  const [disk, setDisk] = useState<AgentSession[]>([]);

  const isProject = session.kind === "project";
  const cwd = session.cwd;

  // On-disk sessions for the picked agent type + this project.
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

  const openAgents = session.agents;
  const bmOfType = agentBookmarks.filter((b) => b.type === type);
  const resumable = disk.filter((d) => !bmOfType.some((b) => b.id === d.id));

  // A fresh agent's bookmark carries a sikemux id (no on-disk session yet),
  // so it just spawns a new agent; a real session id resumes.
  const openBookmark = (b: AgentBookmark) =>
    b.id.startsWith("agent-")
      ? addAgent(b.type)
      : addAgent(b.type, b.id, b.title);

  if (!isProject) {
    return (
      <aside className="agent-rail">
        <div className="agent-empty">agents are project-scoped</div>
      </aside>
    );
  }

  return (
    <aside className="agent-rail">
      <div className="rail-scroll">
        {agentBookmarks.length > 0 && (
          <div className="rail-group-label">Bookmarked</div>
        )}
        {agentBookmarks.map((b) => (
          <button
            key={`bm-${b.type}-${b.id}`}
            className="agent-row"
            onClick={() => openBookmark(b)}
          >
            <span className={`agent-glyph ${b.type}`}>
              <AgentIcon type={b.type} size={16} />
            </span>
            <span className="agent-title">{b.title}</span>
            <span
              className="agent-bm on"
              title="Remove bookmark"
              onClick={(e) => {
                e.stopPropagation();
                toggleAgentBookmark(b);
              }}
            >
              <IconPin size={12} filled />
            </span>
          </button>
        ))}

        {openAgents.length > 0 && (
          <div className="rail-group-label">Open</div>
        )}
        {openAgents.map((a) => {
          const active =
            session.view === "agent" && a.id === session.activeAgentId;
          const bmId = bmIdOf(a);
          const bmOn = agentBookmarks.some(
            (b) => b.type === a.type && b.id === bmId,
          );
          return (
            <button
              key={a.id}
              className={`agent-row${active ? " active" : ""}`}
              onClick={() => selectAgent(a.id)}
            >
              <span className={`agent-glyph ${a.type}`}>
                <AgentIcon type={a.type} size={16} />
              </span>
              <span className="agent-title">{a.title}</span>
              <span
                className={`agent-bm${bmOn ? " on" : ""}`}
                title={bmOn ? "Remove bookmark" : "Bookmark"}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleAgentBookmark({ type: a.type, id: bmId, title: a.title });
                }}
              >
                <IconPin size={12} filled={bmOn} />
              </span>
              <span
                className="agent-close"
                title="Close agent"
                onClick={(e) => {
                  e.stopPropagation();
                  closeAgent(a.id);
                }}
              >
                <IconClose size={11} />
              </span>
            </button>
          );
        })}

        <div className="agent-pills">
          {AGENT_TYPES.map((t) => (
            <button
              key={t}
              className={`agent-pill${type === t ? " active" : ""}`}
              onClick={() => setType(t)}
            >
              <AgentIcon type={t} size={15} />
              {t}
            </button>
          ))}
        </div>

        <div className="agent-sessions-head">
          <span className="rail-group-label">{type} sessions</span>
          <span className="agent-head-actions">
            <button
              className="rail-add"
              title="Search agent sessions"
              onClick={openAgentPalette}
            >
              <IconSearch size={13} />
            </button>
            <button
              className="rail-add"
              title={`new ${type} agent`}
              onClick={() => addAgent(type)}
            >
              <IconPlus size={13} />
            </button>
          </span>
        </div>
        {resumable.length === 0 && disk.length === 0 && (
          <div className="agent-empty">
            no {type} sessions for this project
          </div>
        )}
        {resumable.map((s) => (
          <button
            key={s.id}
            className="agent-row resume"
            onClick={() => addAgent(type, s.id, s.title)}
          >
            <span className={`agent-glyph ${type} dim`}>
              <AgentIcon type={type} size={16} />
            </span>
            <span className="agent-title">{s.title}</span>
            <span
              className="agent-bm"
              title="Bookmark session"
              onClick={(e) => {
                e.stopPropagation();
                toggleAgentBookmark({ type, id: s.id, title: s.title });
              }}
            >
              <IconPin size={12} />
            </span>
            <span className="agent-ago">{ago(s.mtime)}</span>
          </button>
        ))}
      </div>
    </aside>
  );
}

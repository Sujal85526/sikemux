import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { agentApi, type AgentSession } from "../api/agents";
import { AGENT_TYPES, type AgentType } from "../state/types";
import { useWorkspace } from "../state/workspace";
import { AgentIcon, IconClose, IconPlus, IconSearch } from "./Icons";

function ago(unixSecs: number): string {
  if (!unixSecs) return "";
  const d = Math.max(0, Date.now() / 1000 - unixSecs);
  if (d < 90) return "now";
  if (d < 3600) return `${Math.round(d / 60)}m`;
  if (d < 86400) return `${Math.round(d / 3600)}h`;
  return `${Math.round(d / 86400)}d`;
}

// The right rail — pick an agent type, browse its open + on-disk sessions.
export function AgentRail() {
  const session = useWorkspace(
    (s) => s.sessions.find((x) => x.id === s.activeSessionId)!,
  );
  const addAgent = useWorkspace((s) => s.addAgent);
  const selectAgent = useWorkspace((s) => s.selectAgent);
  const closeAgent = useWorkspace((s) => s.closeAgent);
  const agentFocusN = useWorkspace((s) => s.agentFocusN);

  const [type, setType] = useState<AgentType>("claude");
  const [query, setQuery] = useState("");
  const [disk, setDisk] = useState<AgentSession[]>([]);
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const isProject = session.kind === "project";
  const cwd = session.cwd;

  // Existing on-disk sessions for the picked agent type + this project.
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

  // M-c focuses the search.
  useEffect(() => {
    if (agentFocusN > 0) inputRef.current?.focus();
  }, [agentFocusN]);

  const openAgents = session.agents.filter((a) => a.type === type);
  const resumable = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? disk.filter((d) => d.title.toLowerCase().includes(q)) : disk;
  }, [disk, query]);

  // Keyboard cursor spans: [open agents..., new, resumable...].
  const newIdx = openAgents.length;
  const rowCount = openAgents.length + 1 + resumable.length;

  useEffect(() => {
    setSel((s) => Math.min(s, Math.max(0, rowCount - 1)));
  }, [rowCount]);
  useEffect(() => {
    scrollRef.current
      ?.querySelector(".agent-row.sel")
      ?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const activateIndex = (i: number) => {
    if (i < openAgents.length) selectAgent(openAgents[i].id);
    else if (i === newIdx) addAgent(type);
    else {
      const s = resumable[i - newIdx - 1];
      if (s) addAgent(type, s.id, s.title);
    }
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => (rowCount ? (s + 1) % rowCount : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => (rowCount ? (s - 1 + rowCount) % rowCount : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      activateIndex(sel);
    } else if (e.key === "Tab") {
      e.preventDefault();
      const i = AGENT_TYPES.indexOf(type);
      const step = e.shiftKey ? -1 : 1;
      setType(AGENT_TYPES[(i + step + AGENT_TYPES.length) % AGENT_TYPES.length]);
      setSel(0);
    } else if (e.key === "Escape") {
      inputRef.current?.blur();
    }
  };

  if (!isProject) {
    return (
      <aside className="agent-rail">
        <div className="rail-head">
          <span className="rail-label">Agents</span>
        </div>
        <div className="agent-empty">agents are project-scoped</div>
      </aside>
    );
  }

  return (
    <aside className="agent-rail">
      <div className="rail-head">
        <span className="rail-label">Agents</span>
      </div>

      <div className="agent-pills">
        {AGENT_TYPES.map((t) => (
          <button
            key={t}
            className={`agent-pill${type === t ? " active" : ""}`}
            onClick={() => {
              setType(t);
              setSel(0);
            }}
          >
            <AgentIcon type={t} size={15} />
            {t}
          </button>
        ))}
      </div>

      <div className="agent-search">
        <IconSearch size={13} className="agent-search-icon" />
        <input
          ref={inputRef}
          className="agent-search-input"
          placeholder={`search ${type} sessions…`}
          value={query}
          spellCheck={false}
          onChange={(e) => {
            setQuery(e.target.value);
            setSel(0);
          }}
          onKeyDown={onKeyDown}
        />
      </div>

      <div className="rail-scroll" ref={scrollRef}>
        {openAgents.length > 0 && <div className="rail-group-label">Open</div>}
        {openAgents.map((a, i) => {
          const active =
            session.view === "agent" && a.id === session.activeAgentId;
          return (
            <button
              key={a.id}
              className={`agent-row${active ? " active" : ""}${sel === i ? " sel" : ""}`}              onClick={() => selectAgent(a.id)}
            >
              <span className={`agent-glyph ${a.type}`}>
                <AgentIcon type={a.type} size={16} />
              </span>
              <span className="agent-title">{a.title}</span>
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

        <button
          className={`agent-row new${sel === newIdx ? " sel" : ""}`}          onClick={() => addAgent(type)}
        >
          <span className="agent-glyph">
            <IconPlus size={16} />
          </span>
          <span className="agent-title">new {type} agent</span>
        </button>

        <div className="rail-group-label">{type} sessions</div>
        {resumable.length === 0 && (
          <div className="agent-empty">
            {disk.length === 0
              ? `no ${type} sessions for this project`
              : "no matches"}
          </div>
        )}
        {resumable.map((s, j) => {
          const i = newIdx + 1 + j;
          return (
            <button
              key={s.id}
              className={`agent-row resume${sel === i ? " sel" : ""}`}              onClick={() => addAgent(type, s.id, s.title)}
            >
              <span className={`agent-glyph ${type} dim`}>
                <AgentIcon type={type} size={16} />
              </span>
              <span className="agent-title">{s.title}</span>
              <span className="agent-ago">{ago(s.mtime)}</span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}

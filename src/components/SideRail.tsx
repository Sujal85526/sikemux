import { useState, type ReactNode } from "react";
import type { Session, SessionKind } from "../state/types";
import { useWorkspace } from "../state/workspace";
import {
  IconAgent,
  IconChevron,
  IconClose,
  IconCommand,
  IconFolder,
  IconPin,
  IconPlus,
  WindowIcon,
} from "./Icons";

function kindIcon(kind: SessionKind): ReactNode {
  if (kind === "project") return <IconFolder size={13} />;
  return <IconCommand size={13} />;
}

export function SideRail() {
  const sessionsById = useWorkspace((s) => s.sessions);
  const sessionOrder = useWorkspace((s) => s.sessionOrder);
  const activeSessionId = useWorkspace((s) => s.activeSessionId);
  const selectSession = useWorkspace((s) => s.selectSession);
  const selectWindowId = useWorkspace((s) => s.selectWindowId);
  const focusAgents = useWorkspace((s) => s.focusAgents);
  const openPicker = useWorkspace((s) => s.openPicker);
  const togglePin = useWorkspace((s) => s.togglePin);
  const closeSession = useWorkspace((s) => s.closeSession);
  const sessions = sessionOrder.map((id) => sessionsById[id]);

  // Per-project collapse state — projects default to expanded.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggleCollapse = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const pinned = sessions.filter((s) => s.pinned);
  const projects = sessions.filter((s) => !s.pinned && s.kind === "project");
  const commands = sessions.filter((s) => !s.pinned && s.kind === "command");

  // Window/agent click in any project row — jumps to that project first.
  const jumpToWindow = (sessionId: string, winId: string) => {
    if (sessionId !== activeSessionId) selectSession(sessionId);
    selectWindowId(winId);
  };
  const jumpToAgents = (sessionId: string) => {
    if (sessionId !== activeSessionId) selectSession(sessionId);
    focusAgents();
  };

  const Row = ({ s }: { s: Session }) => {
    const active = s.id === activeSessionId;
    const isProject = s.kind === "project";
    const open = isProject && !collapsed.has(s.id);
    return (
      <div>
        <button
          className={`sess-row${active ? " active" : ""}`}
          onClick={() => selectSession(s.id)}
        >
          {isProject ? (
            <span
              className={`sess-chev${open ? " open" : ""}`}
              title={open ? "Collapse" : "Expand"}
              onClick={(e) => {
                e.stopPropagation();
                toggleCollapse(s.id);
              }}
            >
              <IconChevron size={11} />
            </span>
          ) : (
            <span className="sess-chev sess-chev-empty" />
          )}
          <span className={`sess-icon ${s.kind}`}>{kindIcon(s.kind)}</span>
          <span className="sess-name">{s.name}</span>
          <span
            className={`sess-pin${s.pinned ? " on" : ""}`}
            title={s.pinned ? "Unpin" : "Pin"}
            onClick={(e) => {
              e.stopPropagation();
              togglePin(s.id);
            }}
          >
            <IconPin size={11} filled={s.pinned} />
          </span>
          <span
            className="sess-close"
            title="Close session"
            onClick={(e) => {
              e.stopPropagation();
              closeSession(s.id);
            }}
          >
            <IconClose size={11} />
          </span>
        </button>
        {open && (
          <div className="win-list">
            {s.windows.map((w, i) => {
              const winActive =
                active && s.view === "windows" && w.id === s.activeWindowId;
              return (
                <button
                  key={w.id}
                  className={`win-row${winActive ? " active" : ""}`}
                  onClick={() => jumpToWindow(s.id, w.id)}
                >
                  <span className="win-rail">
                    <span className="win-tick" />
                  </span>
                  <span className="win-icon">
                    <WindowIcon name={w.name} size={13} />
                  </span>
                  <span className="win-name">{w.name}</span>
                  <span className="win-index">{i + 1}</span>
                </button>
              );
            })}
            <button
              className={`win-row${
                active && s.view === "agent" ? " active" : ""
              }`}
              onClick={() => jumpToAgents(s.id)}
            >
              <span className="win-rail">
                <span className="win-tick" />
              </span>
              <span className="win-icon">
                <IconAgent size={13} />
              </span>
              <span className="win-name">agents</span>
              <span className="win-index">{s.agents.length}</span>
            </button>
          </div>
        )}
      </div>
    );
  };

  const Group = ({ label, list }: { label: string; list: Session[] }) =>
    list.length === 0 ? null : (
      <div className="rail-group">
        <div className="rail-group-label">{label}</div>
        {list.map((s) => (
          <Row key={s.id} s={s} />
        ))}
      </div>
    );

  return (
    <aside className="side-rail">
      <div className="rail-head">
        <span className="rail-label">Sessions</span>
        <button className="rail-add" onClick={openPicker} title="Open — M-s">
          <IconPlus size={13} />
        </button>
      </div>

      <div className="rail-scroll">
        <Group label="Superpin" list={pinned} />
        <Group label="Projects" list={projects} />
        <Group label="Command" list={commands} />
      </div>

      <button className="rail-foot" onClick={openPicker}>
        <span className="kbd">M-s</span>
        <span>open or create a session</span>
      </button>
    </aside>
  );
}

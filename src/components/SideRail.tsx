import { useState, type ReactNode } from "react";
import type { Session, SessionKind } from "../state/types";
import { useWorkspace } from "../state/workspace";
import {
  AgentIcon,
  IconAgent,
  IconClose,
  IconCommand,
  IconFolder,
  IconFolderOpen,
  IconPin,
  IconPlus,
  WindowIcon,
} from "./Icons";

function kindIcon(kind: SessionKind, open: boolean): ReactNode {
  if (kind === "project")
    return open ? <IconFolderOpen size={13} /> : <IconFolder size={13} />;
  // SSH and Command both use the terminal-arrow icon — fine, the group
  // label in the rail keeps them visually distinct without a custom icon.
  return <IconCommand size={13} />;
}

// Term tab = the "term" window itself plus any number-named windows that
// Alt+N spawns. They're shown as tabs at the top of the stage; in the rail
// they collapse into the single "term" row with a count badge.
function isTermTab(name: string): boolean {
  return name === "term" || /^\d+$/.test(name);
}

// Total number of terminal tabs in a session (each tab is a Window).
function termTabCount(s: Session): number {
  return s.windows.filter((w) => isTermTab(w.name)).length;
}

const STACK_MAX = 4;

// Tiny stacked badge — overlapping circles, capped at STACK_MAX. Used to
// surface "this session has 3 terminals + 2 agents" without numbers.
function CountStack({
  count,
  kind,
  agentKinds,
  title,
}: {
  count: number;
  kind: "term" | "agent";
  agentKinds?: string[]; // for agents: which type per circle
  title: string;
}) {
  if (count === 0) return null;
  const visible = Math.min(count, STACK_MAX);
  return (
    <span
      className={`sess-stack stack-${kind}`}
      title={title}
      data-count={count}
    >
      {Array.from({ length: visible }).map((_, i) => {
        const overflowing = count > STACK_MAX;
        const isMore = overflowing && i === visible - 1;
        // When overflowing we show STACK_MAX-1 real icons and one count
        // chip, so the overflow text is the remaining hidden count.
        const overflowText = isMore ? `+${count - (STACK_MAX - 1)}` : null;
        const agentType = agentKinds?.[i] as
          | "claude"
          | "codex"
          | "hermes"
          | undefined;
        return (
          <span
            key={i}
            className={`stack-dot${isMore ? " more" : ""}${
              kind === "agent" && agentType && !isMore
                ? ` agent-glyph ${agentType}`
                : ""
            }`}
          >
            {overflowText ? (
              <span className="stack-more-num">{overflowText}</span>
            ) : kind === "term" ? (
              <IconCommand size={13} />
            ) : (
              <AgentIcon type={agentType ?? "claude"} size={20} />
            )}
          </span>
        );
      })}
    </span>
  );
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
  const sshs = sessions.filter((s) => !s.pinned && s.kind === "ssh");
  const cloud = sessions.filter((s) => !s.pinned && s.kind === "aws");
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
          <span
            className={`sess-icon ${s.kind}${isProject ? " toggle" : ""}`}
            title={isProject ? (open ? "Collapse" : "Expand") : undefined}
            onClick={
              isProject
                ? (e) => {
                    e.stopPropagation();
                    toggleCollapse(s.id);
                  }
                : undefined
            }
          >
            {kindIcon(s.kind, open)}
          </span>
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
            {(() => {
              // Hide the auto-numbered term tabs from the rail; the "term"
              // row's stack badge shows the total count instead.
              const railWindows = s.windows.filter(
                (w) => !(/^\d+$/.test(w.name)),
              );
              const tabCount = termTabCount(s);
              return railWindows.map((w, i) => {
                const winActive =
                  active && s.view === "windows" &&
                  (w.id === s.activeWindowId ||
                    // Treat "term" as active when any term-tab is active.
                    (w.name === "term" &&
                      isTermTab(
                        s.windows.find((x) => x.id === s.activeWindowId)?.name ?? "",
                      )));
                const isTerm = w.name === "term";
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
                    {isTerm && tabCount > 0 ? (
                      <CountStack
                        count={tabCount}
                        kind="term"
                        title={`${tabCount} terminal tab${tabCount === 1 ? "" : "s"}`}
                      />
                    ) : (
                      <span className="win-index">{i + 1}</span>
                    )}
                  </button>
                );
              });
            })()}
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
              {s.agents.length > 0 ? (
                <CountStack
                  count={s.agents.length}
                  kind="agent"
                  agentKinds={s.agents.map((a) => a.type)}
                  title={`${s.agents.length} agent${s.agents.length === 1 ? "" : "s"}`}
                />
              ) : (
                <span className="win-index">0</span>
              )}
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
        <button
          className="rail-add"
          onClick={() => openPicker("ssh")}
          title="SSH host — M-S"
        >
          <IconCommand size={13} />
        </button>
        <button
          className="rail-add"
          onClick={() => openPicker("all")}
          title="Open — M-s"
        >
          <IconPlus size={13} />
        </button>
      </div>

      <div className="rail-scroll">
        <Group label="Superpin" list={pinned} />
        <Group label="Projects" list={projects} />
        <Group label="SSH" list={sshs} />
        <Group label="Cloud" list={cloud} />
        <Group label="Command" list={commands} />
      </div>

      <button className="rail-foot" onClick={() => openPicker("all")}>
        <span className="kbd">M-s</span>
        <span>open or create a session</span>
      </button>
    </aside>
  );
}

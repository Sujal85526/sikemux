import { useState, type ReactNode } from "react";
import type { Session, SessionKind, Window } from "../state/types";
import * as cmd from "../state/commands";
import { useStore } from "../state/store";
import {
  AgentIcon,
  IconAgent,
  IconAws,
  IconChevron,
  IconClose,
  IconCommand,
  IconFolder,
  IconPin,
  IconPlus,
  IconRundeck,
  WindowIcon,
} from "./Icons";

function kindIcon(kind: SessionKind): ReactNode {
  if (kind === "project") return <IconFolder size={13} />;
  if (kind === "aws") return <IconAws size={26} />;
  if (kind === "rundeck") return <IconRundeck size={14} />;
  return <IconCommand size={13} />;
}

const STACK_MAX = 4;

// Tiny stacked badge — overlapping circles, capped at STACK_MAX.
function CountStack({
  count,
  kind,
  agentKinds,
  title,
}: {
  count: number;
  kind: "term" | "agent";
  agentKinds?: string[];
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
  const sessionsById = useStore((s) => s.sessions);
  const sessionOrder = useStore((s) => s.sessionOrder);
  const windowsById = useStore((s) => s.windows);
  const windowsBySession = useStore((s) => s.windowsBySession);
  const agentsBySession = useStore((s) => s.agentsBySession);
  const agentsById = useStore((s) => s.agents);
  const activeSessionId = useStore((s) => s.activeSessionId);
  const sessions = sessionOrder.map((id) => sessionsById[id]);

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
  const cicd = sessions.filter((s) => !s.pinned && s.kind === "rundeck");
  const commands = sessions.filter((s) => !s.pinned && s.kind === "command");

  const jumpToWindow = (sessionId: string, winId: string) => {
    if (sessionId !== activeSessionId) cmd.selectSession(sessionId);
    cmd.selectWindowId(winId);
  };
  const jumpToAgents = (sessionId: string) => {
    if (sessionId !== activeSessionId) cmd.selectSession(sessionId);
    cmd.focusAgents();
  };

  const Row = ({ s }: { s: Session }) => {
    const active = s.id === activeSessionId;
    const isProject = s.kind === "project";
    const open = isProject && !collapsed.has(s.id);
    const winIds = windowsBySession[s.id] ?? [];
    const sessionWindows = winIds
      .map((id) => windowsById[id])
      .filter(Boolean) as Window[];
    const agentIds = agentsBySession[s.id] ?? [];
    const tabCount = sessionWindows.filter((w) => w.role === "term").length;
    const agents = agentIds.map((id) => agentsById[id]).filter(Boolean);
    return (
      <div>
        <button
          className={`sess-row${active ? " active" : ""}`}
          onClick={() => cmd.selectSession(s.id)}
        >
          <span
            className={`sess-icon ${s.kind}${isProject ? " toggle" : ""}${
              isProject && open ? " open" : ""
            }`}
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
            <span className="sess-icon-glyph">{kindIcon(s.kind)}</span>
            {isProject && (
              <span className="sess-icon-chev">
                <IconChevron size={11} />
              </span>
            )}
          </span>
          <span className="sess-name">{s.name}</span>
          <span
            className={`sess-pin${s.pinned ? " on" : ""}`}
            title={s.pinned ? "Unpin" : "Pin"}
            onClick={(e) => {
              e.stopPropagation();
              cmd.togglePin(s.id);
            }}
          >
            <IconPin size={11} filled={s.pinned} />
          </span>
          <span
            className="sess-close"
            title="Close session"
            onClick={(e) => {
              e.stopPropagation();
              cmd.closeSession(s.id);
            }}
          >
            <IconClose size={11} />
          </span>
        </button>
        {open && (
          <div className="win-list">
            {(() => {
              // Auto-numbered term tabs (Alt+N spawns) collapse into the
              // canonical "term" row — they don't deserve their own rail
              // entry. We pick them out by structural role + numeric name.
              const railWindows = sessionWindows.filter(
                (w) => !(w.role === "term" && /^\d+$/.test(w.name)),
              );
              return railWindows.map((w, i) => {
                const activeRole =
                  sessionWindows.find((x) => x.id === s.activeWindowId)?.role;
                const winActive =
                  active && s.view === "windows" &&
                  (w.id === s.activeWindowId ||
                    (w.role === "term" && activeRole === "term"));
                const isTerm = w.role === "term" && w.name === "term";
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
                      <WindowIcon role={w.role} size={13} />
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
              {agents.length > 0 ? (
                <CountStack
                  count={agents.length}
                  kind="agent"
                  agentKinds={agents.map((a) => a.type)}
                  title={`${agents.length} agent${agents.length === 1 ? "" : "s"}`}
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

  const Group = ({
    label,
    list,
    add,
    addTitle,
    emptyText,
  }: {
    label: string;
    list: Session[];
    add?: () => void;
    addTitle?: string;
    emptyText: string;
  }) => (
    <div className="rail-group">
      <div className="rail-group-head">
        <span className="rail-group-label">{label}</span>
        {add && (
          <button
            className="rail-group-add"
            onClick={add}
            title={addTitle}
          >
            <IconPlus size={11} />
          </button>
        )}
      </div>
      {list.length === 0 ? (
        add ? (
          <button className="rail-group-empty interactive" onClick={add}>
            {emptyText}
          </button>
        ) : (
          <div className="rail-group-empty">{emptyText}</div>
        )
      ) : (
        list.map((s) => <Row key={s.id} s={s} />)
      )}
    </div>
  );

  return (
    <aside className="side-rail">
      <div className="rail-scroll">
        <Group
          label="Superpin"
          list={pinned}
          emptyText="pin a session to bookmark it"
        />
        <Group
          label="Projects"
          list={projects}
          add={() => cmd.openPicker("projects")}
          addTitle="Open project — M-s"
          emptyText="no projects"
        />
        <Group
          label="SSH"
          list={sshs}
          add={() => cmd.openPicker("ssh")}
          addTitle="Connect to SSH host — M-S"
          emptyText="no ssh hosts"
        />
        <Group
          label="Cloud"
          list={cloud}
          add={cmd.openAwsSession}
          addTitle="Open AWS"
          emptyText="no cloud sessions"
        />
        <Group
          label="CI/CD"
          list={cicd}
          add={cmd.openRundeckSession}
          addTitle="Open Rundeck deploy center"
          emptyText="open rundeck deploy center"
        />
        <Group
          label="Command"
          list={commands}
          add={cmd.createCommandSession}
          addTitle="New command session"
          emptyText="no commands"
        />
      </div>

      <button className="rail-foot" onClick={() => cmd.openPicker("all")}>
        <span className="kbd">M-s</span>
        <span>open or create a session</span>
      </button>
    </aside>
  );
}

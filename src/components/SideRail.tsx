import { type ReactNode } from "react";
import type { Session, SessionKind, Window, WindowRole } from "../state/types";
import * as cmd from "../state/commands";
import { useStore } from "../state/store";
import {
  AgentIcon,
  IconAgent,
  IconAws,
  IconClose,
  IconCommand,
  IconFolder,
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

// Max glyphs shown before collapsing the rest into a "+N" overflow chip.
// 3 visible + 1 "+N" = 4 stack slots, matching today's horizontal cap.
const STACK_MAX = 4;

/** Vertical brand-glyph stack — same circles + colors as the old horizontal
 *  CountStack, just rotated so it sits below the parent icon. Used under
 *  the `term` icon (green dots with `>_`) and the `agents` icon (colored
 *  by agent type: claude / codex / hermes). Returns null at count = 0. */
function VerticalStack({
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
    <span className={`proj-vstack vstack-${kind}`} title={title} data-count={count}>
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
            className={`proj-glyph${isMore ? " more" : ""}${
              kind === "agent" && agentType && !isMore
                ? ` agent-glyph ${agentType}`
                : ""
            }`}
          >
            {overflowText ? (
              <span className="proj-glyph-num">{overflowText}</span>
            ) : kind === "term" ? (
              <IconCommand size={11} />
            ) : (
              <AgentIcon type={agentType ?? "claude"} size={14} />
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

  // No Superpin group + no per-session pin button in the rail — pinning
  // is a bookmark-only concept that lives in the agent rail. Sessions
  // remain grouped purely by kind, in the order they were opened.
  const projects = sessions.filter((s) => s.kind === "project");
  const sshs = sessions.filter((s) => s.kind === "ssh");
  const cloud = sessions.filter((s) => s.kind === "aws");
  const cicd = sessions.filter((s) => s.kind === "rundeck");
  const commands = sessions.filter((s) => s.kind === "command");

  const jumpToWindow = (sessionId: string, winId: string) => {
    if (sessionId !== activeSessionId) cmd.selectSession(sessionId);
    cmd.selectWindowId(winId);
  };
  const jumpToAgents = (sessionId: string) => {
    if (sessionId !== activeSessionId) cmd.selectSession(sessionId);
    cmd.focusAgents();
  };

  /** Project rows: always-visible 2-row block (name + 5-icon hop bar).
   *  Active sub-icon spotlit by the parent project's `view` + activeRole.
   *  Vertical glyph stacks sit directly below the term / agents icons via
   *  a strict per-icon column so they line up center-aligned. */
  const ProjectBlock = ({ s }: { s: Session }) => {
    const active = s.id === activeSessionId;
    const winIds = windowsBySession[s.id] ?? [];
    const sessionWindows = winIds
      .map((id) => windowsById[id])
      .filter(Boolean) as Window[];
    const agentIds = agentsBySession[s.id] ?? [];
    const agents = agentIds.map((id) => agentsById[id]).filter(Boolean);
    const tabCount = sessionWindows.filter((w) => w.role === "term").length;

    // First window of each role (project sessions always have one of each
    // canonical role — files/term/git/search). `term` may also have
    // numeric-named siblings from Alt+N; those collapse into the stack.
    const winByRole = (role: WindowRole): Window | undefined =>
      sessionWindows.find((w) => w.role === role);
    const activeRole = sessionWindows.find(
      (w) => w.id === s.activeWindowId,
    )?.role;
    const inAgentView = active && s.view === "agent";
    const inWindowsView = active && s.view === "windows";
    const isSubActive = (role: WindowRole | "agents"): boolean => {
      if (role === "agents") return inAgentView;
      return inWindowsView && activeRole === role;
    };

    const onIconClick = (role: WindowRole | "agents") => {
      if (role === "agents") {
        jumpToAgents(s.id);
        return;
      }
      const w = winByRole(role);
      if (w) jumpToWindow(s.id, w.id);
    };

    // Per-icon column: icon button + optional vertical stack below.
    const iconCol = (
      role: WindowRole | "agents",
      titleText: string,
      stack?: ReactNode,
    ) => {
      const subActive = isSubActive(role);
      const node =
        role === "agents" ? <IconAgent size={14} /> : <WindowIcon role={role} size={14} />;
      return (
        <div className="proj-icol" key={role}>
          <button
            type="button"
            className={`proj-ic${subActive ? " active" : ""}`}
            title={titleText}
            onClick={(e) => {
              e.stopPropagation();
              onIconClick(role);
            }}
          >
            {node}
          </button>
          {stack}
        </div>
      );
    };

    return (
      <div className={`proj-block${active ? " active" : ""}`}>
        <button
          className="proj-name-row"
          onClick={() => cmd.selectSession(s.id)}
          title={s.cwd || s.name}
        >
          <span className="proj-folder">
            <IconFolder size={13} />
          </span>
          <span className="proj-name">{s.name}</span>
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
        <div className="proj-icons">
          {iconCol("files", "files (M-i)")}
          {iconCol(
            "term",
            `term${tabCount > 1 ? ` (${tabCount} tabs)` : ""} (M-r)`,
            // Only show the term stack when there are multiple tabs — a
            // single default term doesn't deserve a decoration glyph.
            tabCount > 1 ? (
              <VerticalStack
                count={tabCount}
                kind="term"
                title={`${tabCount} terminal tab${tabCount === 1 ? "" : "s"}`}
              />
            ) : undefined,
          )}
          {iconCol("git", "git (M-g)")}
          {iconCol(
            "agents",
            `agents${agents.length ? ` (${agents.length})` : ""} (M-c)`,
            <VerticalStack
              count={agents.length}
              kind="agent"
              agentKinds={agents.map((a) => a.type)}
              title={`${agents.length} agent${agents.length === 1 ? "" : "s"}`}
            />,
          )}
          {iconCol("search", "search (M-f)")}
        </div>
      </div>
    );
  };

  /** Non-project sessions (ssh / command / aws / rundeck): keep the
   *  existing single-row layout. They don't have the files/term/git
   *  sub-area split — one session ≡ one main pane. */
  const SimpleRow = ({ s }: { s: Session }) => {
    const active = s.id === activeSessionId;
    return (
      <button
        className={`sess-row${active ? " active" : ""}`}
        onClick={() => cmd.selectSession(s.id)}
      >
        <span className={`sess-icon ${s.kind}`}>
          <span className="sess-icon-glyph">{kindIcon(s.kind)}</span>
        </span>
        <span className="sess-name">{s.name}</span>
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
    );
  };

  const renderSession = (s: Session) =>
    s.kind === "project" ? (
      <ProjectBlock key={s.id} s={s} />
    ) : (
      <SimpleRow key={s.id} s={s} />
    );

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
        list.map(renderSession)
      )}
    </div>
  );

  return (
    <aside className="side-rail">
      <div className="rail-scroll">
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

import type { ReactNode } from "react";
import type {
  AgentType,
  Session,
  SessionKind,
  Window,
  WindowRole,
} from "../state/types";
import * as cmd from "../state/commands";
import { useStore } from "../state/store";
import {
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

/** Pick the most-frequent agent type for color-coding. Ties broken by
 *  insertion order (whichever the user spawned first). Default = claude
 *  so we never render a colorless badge. */
function primaryAgentType(types: AgentType[]): AgentType {
  if (types.length === 0) return "claude";
  const counts = new Map<AgentType, number>();
  for (const t of types) counts.set(t, (counts.get(t) ?? 0) + 1);
  let best: AgentType = types[0];
  let bestN = 0;
  for (const [t, n] of counts) if (n > bestN) { best = t; bestN = n; }
  return best;
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

  /** Project rows: collapsible tree.
   *
   *  Inactive project = single name row prefixed by a ▸ chevron, with an
   *  optional right-aligned hint chip (agent count badge) so the user can
   *  spot background activity without expanding.
   *
   *  Active project = ▾ header row + an indented child block listing the
   *  5 pane types as `icon  Label  [n]` rows. The currently-focused pane
   *  gets the accent color + active dot. Children are click targets that
   *  hop directly to that pane within this project. */
  const ProjectBlock = ({ s }: { s: Session }) => {
    const active = s.id === activeSessionId;
    const winIds = windowsBySession[s.id] ?? [];
    const sessionWindows = winIds
      .map((id) => windowsById[id])
      .filter(Boolean) as Window[];
    const agentIds = agentsBySession[s.id] ?? [];
    const agents = agentIds.map((id) => agentsById[id]).filter(Boolean);
    const tabCount = sessionWindows.filter((w) => w.role === "term").length;

    if (!active) {
      // Collapsed: name + optional agent-count hint badge.
      return (
        <button
          className="proj-row collapsed"
          onClick={() => cmd.selectSession(s.id)}
          title={s.cwd || s.name}
        >
          <span className="proj-chev">▸</span>
          <span className="proj-folder">
            <IconFolder size={12} />
          </span>
          <span className="proj-name">{s.name}</span>
          {agents.length > 0 && (
            <span className="proj-hint">
              <IconAgent size={11} />
              <span
                className={`proj-hint-n badge-${primaryAgentType(agents.map((a) => a.type))}`}
              >
                {agents.length > 9 ? "9+" : agents.length}
              </span>
            </span>
          )}
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
    }

    // Expanded.
    const winByRole = (role: WindowRole): Window | undefined =>
      sessionWindows.find((w) => w.role === role);
    const activeRole = sessionWindows.find(
      (w) => w.id === s.activeWindowId,
    )?.role;
    const inAgentView = s.view === "agent";
    const inWindowsView = s.view === "windows";
    const isSubActive = (role: WindowRole | "agents"): boolean => {
      if (role === "agents") return inAgentView;
      return inWindowsView && activeRole === role;
    };

    const onSubClick = (role: WindowRole | "agents") => {
      if (role === "agents") {
        jumpToAgents(s.id);
        return;
      }
      const w = winByRole(role);
      if (w) jumpToWindow(s.id, w.id);
    };

    type SubRow = {
      role: WindowRole | "agents";
      label: string;
      title: string;
      count?: number;
      tone?: "term" | AgentType;
    };
    const children: SubRow[] = [
      { role: "files", label: "Files", title: "files (M-i)" },
      {
        role: "term",
        label: "Term",
        title: `term${tabCount > 1 ? ` (${tabCount} tabs)` : ""} (M-r)`,
        count: tabCount > 1 ? tabCount : undefined,
        tone: "term",
      },
      { role: "git", label: "Git", title: "git (M-g)" },
      {
        role: "agents",
        label: "Agents",
        title: `agents${agents.length ? ` (${agents.length})` : ""} (M-c)`,
        count: agents.length > 0 ? agents.length : undefined,
        tone:
          agents.length > 0
            ? primaryAgentType(agents.map((a) => a.type))
            : undefined,
      },
      { role: "search", label: "Search", title: "search (M-f)" },
    ];

    return (
      <div className="proj-tree active">
        <button
          className="proj-row expanded"
          onClick={() => cmd.selectSession(s.id)}
          title={s.cwd || s.name}
        >
          <span className="proj-chev">▾</span>
          <span className="proj-folder">
            <IconFolder size={12} />
          </span>
          <span className="proj-name">{s.name}</span>
          <span className="proj-active-dot" aria-hidden />
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
        <div className="proj-children">
          {children.map((c) => {
            const subActive = isSubActive(c.role);
            const node =
              c.role === "agents" ? (
                <IconAgent size={13} />
              ) : (
                <WindowIcon role={c.role} size={13} />
              );
            return (
              <button
                key={c.role}
                type="button"
                className={`proj-child${subActive ? " active" : ""}`}
                title={c.title}
                onClick={(e) => {
                  e.stopPropagation();
                  onSubClick(c.role);
                }}
              >
                <span className="proj-child-ic">{node}</span>
                <span className="proj-child-label">{c.label}</span>
                {c.count !== undefined && c.tone && (
                  <span className={`proj-child-n badge-${c.tone}`}>
                    {c.count > 9 ? "9+" : c.count}
                  </span>
                )}
                {subActive && (
                  <span className="proj-active-dot" aria-hidden />
                )}
              </button>
            );
          })}
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

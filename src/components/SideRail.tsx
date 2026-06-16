import type { ReactNode } from "react";
import type { Session, SessionKind, Window, WindowRole } from "../state/types";
import * as cmd from "../state/commands";
import { useStore } from "../state/store";
import { AgentIcon, IconAgent, IconAws, IconBruno, IconClose, IconCommand, IconFolder, IconPlus, IconRundeck, Logo, WindowIcon } from "./Icons";
import { ALT, Kbd, SHIFT, hint } from "./Kbd";
import { UpdateChip, VersionChip } from "./TopBar";

function kindIcon(kind: SessionKind): ReactNode {
    if (kind === "project") return <IconFolder size={13} />;
    if (kind === "aws") return <IconAws size={26} />;
    if (kind === "rundeck") return <IconRundeck size={14} />;
    if (kind === "bruno") return <IconBruno size={14} />;
    return <IconCommand size={13} />;
}

const MAX_BADGE_ICONS = 3;

export function SideRail() {
    const sessionsById = useStore((s) => s.sessions);
    const sessionOrder = useStore((s) => s.sessionOrder);
    const windowsById = useStore((s) => s.windows);
    const windowsBySession = useStore((s) => s.windowsBySession);
    const agentsBySession = useStore((s) => s.agentsBySession);
    const agentsById = useStore((s) => s.agents);
    const rawActiveSessionId = useStore((s) => s.activeSessionId);
    const settingsOpen = useStore((s) => s.settingsOpen);
    const activeSessionId = settingsOpen ? "" : rawActiveSessionId;
    const sessions = sessionOrder.map((id) => sessionsById[id]);

    const projects = sessions.filter((s) => s.kind === "project");
    const sshs = sessions.filter((s) => s.kind === "ssh");
    const cloud = sessions.filter((s) => s.kind === "aws");
    const cicd = sessions.filter((s) => s.kind === "rundeck");
    const apis = sessions.filter((s) => s.kind === "bruno");
    const commands = sessions.filter((s) => s.kind === "command");

    const jumpToWindow = (sessionId: string, winId: string) => {
        if (sessionId !== activeSessionId) cmd.selectSession(sessionId);
        cmd.selectWindowId(winId);
    };
    const jumpToAgents = (sessionId: string) => {
        if (sessionId !== activeSessionId) cmd.selectSession(sessionId);
        cmd.focusAgents();
    };

    const ProjectBlock = ({ s }: { s: Session }) => {
        const active = s.id === activeSessionId;
        const winIds = windowsBySession[s.id] ?? [];
        const sessionWindows = winIds.map((id) => windowsById[id]).filter(Boolean) as Window[];
        const agentIds = agentsBySession[s.id] ?? [];
        const agents = agentIds.map((id) => agentsById[id]).filter(Boolean);
        const tabCount = sessionWindows.filter((w) => w.role === "term").length;

        if (!active) {
            const visible = agents.slice(0, MAX_BADGE_ICONS);
            const overflow = agents.length - visible.length;
            return (
                <button className="proj-row collapsed" onClick={() => cmd.selectSession(s.id)} title={s.cwd || s.name}>
                    <span className="proj-folder">
                        <IconFolder size={12} />
                    </span>
                    <span className="proj-name">{s.name}</span>
                    {visible.length > 0 && (
                        <span className="proj-child-icons">
                            {visible.map((a) => (
                                <span key={a.id} className={`proj-pip proj-pip-${a.type}`}>
                                    <AgentIcon type={a.type} size={20} />
                                </span>
                            ))}
                            {overflow > 0 && <span className="proj-child-icons-more">+{overflow}</span>}
                        </span>
                    )}
                    <span
                        className="sess-close"
                        title="Close session"
                        onClick={(e) => {
                            e.stopPropagation();
                            cmd.closeSession(s.id);
                        }}>
                        <IconClose size={11} />
                    </span>
                </button>
            );
        }

        const winByRole = (role: WindowRole): Window | undefined => sessionWindows.find((w) => w.role === role);
        const activeRole = sessionWindows.find((w) => w.id === s.activeWindowId)?.role;
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

        const termIcons: React.ReactNode[] =
            tabCount > 1
                ? Array.from({ length: tabCount }, (_, i) => (
                      <span key={i} className="proj-pip proj-pip-term">
                          <IconCommand size={14} />
                      </span>
                  ))
                : [];
        const agentIcons: React.ReactNode[] = agents.map((a) => (
            <span key={a.id} className={`proj-pip proj-pip-${a.type}`}>
                <AgentIcon type={a.type} size={20} />
            </span>
        ));

        type SubRow = {
            role: WindowRole | "agents";
            label: string;
            kbd: string;
            title: string;
            icons: React.ReactNode[];
        };
        const children: SubRow[] = [
            { role: "files", label: "Files", kbd: hint(ALT, "I"), title: `Files — ${hint(ALT, "I")}`, icons: [] },
            {
                role: "term",
                label: "Term",
                kbd: hint(ALT, "R"),
                title: `Term${tabCount > 1 ? ` · ${tabCount} tabs` : ""} — ${hint(ALT, "R")}`,
                icons: termIcons,
            },
            { role: "git", label: "Git", kbd: hint(ALT, "G"), title: `Git — ${hint(ALT, "G")}`, icons: [] },
            {
                role: "agents",
                label: "Agents",
                kbd: hint(ALT, "C"),
                title: `Agents${agents.length ? ` · ${agents.length}` : ""} — ${hint(ALT, "C")}`,
                icons: agentIcons,
            },
            { role: "search", label: "Search", kbd: hint(ALT, "F"), title: `Search — ${hint(ALT, "F")}`, icons: [] },
        ];

        return (
            <div className="proj-tree active">
                <button className="proj-row expanded" onClick={() => cmd.selectSession(s.id)} title={s.cwd || s.name}>
                    <span className="proj-folder">
                        <IconFolder size={12} />
                    </span>
                    <span className="proj-name">{s.name}</span>
                    <span
                        className="sess-close"
                        title="Close session"
                        onClick={(e) => {
                            e.stopPropagation();
                            cmd.closeSession(s.id);
                        }}>
                        <IconClose size={11} />
                    </span>
                </button>
                <div className="proj-children">
                    {children.map((c) => {
                        const subActive = isSubActive(c.role);
                        const node = c.role === "agents" ? <IconAgent size={13} /> : <WindowIcon role={c.role} size={13} />;
                        const visibleIcons = c.icons.slice(0, MAX_BADGE_ICONS);
                        const overflow = c.icons.length - visibleIcons.length;
                        return (
                            <button
                                key={c.role}
                                type="button"
                                className={`proj-child${subActive ? " active" : ""}`}
                                title={c.title}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onSubClick(c.role);
                                }}>
                                <span className="proj-child-tick" />
                                <span className="proj-child-ic">{node}</span>
                                <span className="proj-child-label">{c.label}</span>
                                {visibleIcons.length > 0 && (
                                    <span className="proj-child-icons">
                                        {visibleIcons}
                                        {overflow > 0 && <span className="proj-child-icons-more">+{overflow}</span>}
                                    </span>
                                )}
                                <span className="proj-child-kbd">{c.kbd}</span>
                            </button>
                        );
                    })}
                </div>
            </div>
        );
    };

    const SimpleRow = ({ s }: { s: Session }) => {
        const active = s.id === activeSessionId;
        return (
            <button className={`sess-row${active ? " active" : ""}`} onClick={() => cmd.selectSession(s.id)}>
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
                    }}>
                    <IconClose size={11} />
                </span>
            </button>
        );
    };

    const renderSession = (s: Session) => (s.kind === "project" ? <ProjectBlock key={s.id} s={s} /> : <SimpleRow key={s.id} s={s} />);

    const Group = ({
        label,
        list,
        add,
        addTitle,
        addKbd,
        emptyText,
    }: {
        label: string;
        list: Session[];
        add?: () => void;
        addTitle?: string;
        addKbd?: string;
        emptyText: string;
    }) => (
        <div className="rail-group">
            <div className="rail-group-head">
                <span className="rail-group-label">{label}</span>
                <span className="rail-group-rule" />
                {add && (
                    <span className="rail-group-actions">
                        {addKbd && <span className="rail-group-kbd">{addKbd}</span>}
                        <button className="rail-group-add" onClick={add} title={addTitle}>
                            <IconPlus size={11} />
                        </button>
                    </span>
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
            <header className="rail-brand">
                <span className="rail-brand-mark">
                    <Logo size={26} />
                </span>
                <span className="rail-brand-name">
                    Sike<span className="rail-brand-dim">mux</span>
                </span>
                <VersionChip />
            </header>
            <div className="rail-scroll">
                <Group
                    label="Projects"
                    list={projects}
                    add={() => cmd.openPicker("projects")}
                    addTitle={`Open project — ${hint(ALT, "P")}`}
                    addKbd={hint(ALT, "P")}
                    emptyText="no projects"
                />
                <Group
                    label="SSH"
                    list={sshs}
                    add={() => cmd.openPicker("ssh")}
                    addTitle={`Connect to SSH host — ${hint(ALT, SHIFT, "S")}`}
                    addKbd={hint(ALT, SHIFT, "S")}
                    emptyText="no ssh hosts"
                />
                <Group
                    label="Cloud"
                    list={cloud}
                    add={cmd.openAwsSession}
                    addTitle={`Open AWS — ${hint(ALT, "A")}`}
                    addKbd={hint(ALT, "A")}
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
                    label="API"
                    list={apis}
                    add={() => cmd.openPicker("bruno")}
                    addTitle={`Open Bruno workspace — ${hint(ALT, "B")}`}
                    addKbd={hint(ALT, "B")}
                    emptyText="open a bruno workspace"
                />
                <Group label="Command" list={commands} add={cmd.createCommandSession} addTitle="New command session" emptyText="no commands" />
            </div>

            <UpdateChip />

            <button className="rail-foot" onClick={() => cmd.openPicker("all")} title={`Open or create a session — ${hint(ALT, "S")}`}>
                <Kbd>{hint(ALT, "S")}</Kbd>
                <span>open or create a session</span>
            </button>
        </aside>
    );
}

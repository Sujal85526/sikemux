import type { ReactNode } from "react";
import { keybindingLabelForAction, type KeybindingActionId } from "../../keybindings";
import * as cmd from "../../state/commands";
import { useStore } from "../../state/store";
import type { Session, SessionKind } from "../../state/types";
import { IconAws, IconBruno, IconClose, IconCommand, IconPencil, IconPlus, IconRundeck } from "../Icons";
import { Tooltip } from "../Tooltip";
import { EmptyState, Panel, PanelHeader } from "../Panel";

function kindIcon(kind: SessionKind): ReactNode {
    if (kind === "aws") return <IconAws />;
    if (kind === "rundeck") return <IconRundeck size={14} />;
    if (kind === "bruno") return <IconBruno size={14} />;
    return <IconCommand size={13} />;
}

interface GroupSpec {
    kind: SessionKind;
    label: string;
    add: () => void;
    addTitle: string;
    addAction?: KeybindingActionId;
    action?: () => void;
    actionTitle?: string;
    empty: string;
}

/**
 * Everything that is not a checkout: hosts, cloud, deploys, API workspaces and
 * loose commands.
 *
 * These keep their groups exactly as they were. The label is not decoration —
 * it is the only place a per-kind action can hang, which is why the pencil that
 * opens ~/.ssh/config belongs to SSH and `+` means something different in every
 * one of them.
 */
const GROUPS: GroupSpec[] = [
    {
        kind: "ssh",
        label: "SSH",
        add: () => cmd.openPicker("ssh"),
        addTitle: "Connect to SSH host",
        addAction: "ssh.open",
        action: () => void cmd.openSshConfigEditor(),
        actionTitle: "Edit ~/.ssh/config",
        empty: "no ssh hosts",
    },
    { kind: "aws", label: "Cloud", add: cmd.openAwsSession, addTitle: "Open AWS", addAction: "aws.open", empty: "no cloud sessions" },
    { kind: "rundeck", label: "CI/CD", add: cmd.openRundeckSession, addTitle: "Open Rundeck deploy center", empty: "open rundeck deploy center" },
    {
        kind: "bruno",
        label: "API",
        add: () => cmd.openPicker("bruno"),
        addTitle: "Open Bruno workspace",
        addAction: "bruno.open",
        empty: "open a bruno workspace",
    },
    { kind: "command", label: "Command", add: cmd.createCommandSession, addTitle: "New command session", empty: "no commands" },
];

function SessionRow({ session, active }: { session: Session; active: boolean }) {
    return (
        <div className="session-row-shell">
            <button className={`sess-row${active ? " active" : ""}`} onClick={() => cmd.selectSession(session.id)}>
                <span className={`sess-icon ${session.kind}`}>
                    <span className="sess-icon-glyph">{kindIcon(session.kind)}</span>
                </span>
                <span className="sess-name">{session.name}</span>
            </button>
            <Tooltip label={`Close ${session.name}`}>
                <button type="button" className="row-x" aria-label={`Close ${session.name}`} onClick={() => cmd.closeSession(session.id)}>
                    <IconClose size={11} />
                </button>
            </Tooltip>
        </div>
    );
}

export function ServicesPage() {
    const sessionsById = useStore((s) => s.sessions);
    const sessionOrder = useStore((s) => s.sessionOrder);
    const activeSessionId = useStore((s) => s.activeSessionId);
    const keybindingOverrides = useStore((s) => s.keybindingOverrides);
    const sessions = sessionOrder.map((id) => sessionsById[id]).filter(Boolean);

    return (
        <div className="rail-page">
            <div className="rail-scroll">
                {GROUPS.map((group) => {
                    const list = sessions.filter((s) => s.kind === group.kind);
                    const kbd = group.addAction ? keybindingLabelForAction(keybindingOverrides, group.addAction) : undefined;
                    const extra = (
                        <span className="rail-group-actions">
                            {kbd && <span className="rail-group-kbd">{kbd}</span>}
                            {group.action && (
                                <Tooltip label={group.actionTitle}>
                                    <button className="rail-group-add" onClick={group.action} aria-label={group.actionTitle} type="button">
                                        <IconPencil size={11} />
                                    </button>
                                </Tooltip>
                            )}
                            <Tooltip label={kbd ? `${group.addTitle} — ${kbd}` : group.addTitle}>
                                <button className="rail-group-add" onClick={group.add} aria-label={group.addTitle} type="button">
                                    <IconPlus size={11} />
                                </button>
                            </Tooltip>
                        </span>
                    );
                    return (
                        <Panel variant="group" key={group.kind}>
                            <PanelHeader label={group.label} rule extra={extra} />
                            {list.length === 0 ? (
                                <EmptyState variant="inline" message={group.empty} action={{ label: group.empty, onClick: group.add }} />
                            ) : (
                                list.map((s) => <SessionRow key={s.id} session={s} active={s.id === activeSessionId} />)
                            )}
                        </Panel>
                    );
                })}
            </div>
        </div>
    );
}

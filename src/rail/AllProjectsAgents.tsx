import { useLayoutEffect, useMemo, useRef, type MouseEvent, type ReactNode, type Ref } from "react";
import { AgentStateIndicator, BackgroundCounts, showsAgentState } from "../agents/AgentStateIndicator";
import * as cmd from "../state/commands";
import { useStore } from "../state/store";
import { inTeams, type TeamLink } from "../agents/teams";
import type { AgentDisplay } from "../state/agentStatus";
import { activeAgentId, agentDisplayOf, openAgents } from "../state/selectors";
import type { Agent } from "../state/types";
import { AgentIcon, IconClose, IconMerge } from "../ui/Icons";
import { Panel, PanelHeader } from "../ui/Panel";
import { Tooltip } from "../ui/Tooltip";
import { AgentLabel } from "../agents/AgentLabel";
import { collisionLabel, type CollisionMark } from "../agents/collisions";
import { AgentRowProject, AgentRowTree } from "./AgentRowTree";
import { isRemoteWorker, RemoteAgentRow, teamWrapClass, withRemoteWorkers } from "./RemoteAgentRow";
import { drawTeamLines } from "./teams";
import { inInboxOrder, useInbox } from "./useInbox";

interface OpenAgentRow {
    id: string;
    lead?: string;
    agent: Agent;
    display: AgentDisplay;
    sessionName: string;
    sessionId: string;
}

/** Every agent open in any project, in the order the inbox wants them. */
export function AllProjectsAgents() {
    const sessionOrder = useStore((s) => s.sessionOrder);
    const sessions = useStore((s) => s.sessions);
    const windows = useStore((s) => s.windows);
    const windowsBySession = useStore((s) => s.windowsBySession);
    const agents = useStore((s) => s.agents);
    const agentActivity = useStore((s) => s.agentActivity);
    const agentTasks = useStore((s) => s.agentTasks);
    const agentSubagents = useStore((s) => s.agentSubagents);
    const { inbox } = useInbox();
    const shownAgentId = useStore((s) => activeAgentId(s, s.sessions[s.activeSessionId]));

    const open = useMemo(() => {
        const rows: OpenAgentRow[] = [];
        for (const { agentId, agent, session } of openAgents({ sessionOrder, sessions, windows, windowsBySession, agents }))
            rows.push({
                id: agentId,
                lead: agent.lead,
                agent,
                display: agentDisplayOf({ agentActivity, agentTasks, agentSubagents }, agentId),
                sessionName: session.name,
                sessionId: session.id,
            });
        return rows;
    }, [sessionOrder, sessions, windows, windowsBySession, agents, agentActivity, agentTasks, agentSubagents]);

    const teams = useMemo(
        () => inTeams(withRemoteWorkers(inInboxOrder(open, inbox.items), inbox.remoteAgents)),
        [open, inbox.items, inbox.remoteAgents],
    );

    const root = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
        if (root.current) drawTeamLines(root.current);
    });

    if (open.length === 0) return <div className="agent-empty">no agents open in any project</div>;

    return (
        <div ref={root} className="agent-all-projects">
            <Panel variant="group" className="agent-group">
                <PanelHeader label={`Open ${open.length}`} rule />
                {teams.map(({ agent: row, link }) =>
                    isRemoteWorker(row) ? (
                        <RemoteAgentRow key={row.id} agent={row.remote} link={link} />
                    ) : (
                        <OpenAgentRow
                            key={row.id}
                            agent={row.agent}
                            display={row.display}
                            link={link}
                            active={row.id === shownAgentId}
                            project={{ name: row.sessionName, sessionId: row.sessionId }}
                        />
                    ),
                )}
            </Panel>
        </div>
    );
}

/** A mark on an agent that just changed the same lines, or the same claimed file, as another. */
function Collided({ agentId }: { agentId: string }) {
    const mark: CollisionMark | undefined = useInbox().inbox.collisions[agentId];
    if (!mark) return null;
    const label = collisionLabel(mark);
    return (
        <span className={`collision-mark${mark.claim ? " claim" : ""}`} title={label} aria-label={label} role="img">
            <IconMerge size={11} />
        </span>
    );
}

/** An open agent's row, with its state, its close, and what it is tied to hung below. `title` replaces its label while it is renamed. */
export function OpenAgentRow({
    agent,
    display,
    link,
    active,
    project,
    title,
    wrap,
    onDoubleClick,
    onContextMenu,
}: {
    agent: Agent;
    display: AgentDisplay;
    link?: TeamLink;
    active: boolean;
    project?: { name: string; sessionId: string };
    title?: ReactNode;
    wrap?: { ref: Ref<HTMLDivElement>; "data-agent-id": string; "data-session": string };
    onDoubleClick?: () => void;
    onContextMenu?: (event: MouseEvent) => void;
}) {
    const glyph = (
        <span className={`agent-glyph ${agent.type}`}>
            <AgentIcon type={agent.type} size={20} />
        </span>
    );
    return (
        <div className={teamWrapClass(link)} {...wrap}>
            {title ? (
                <div className={`agent-row${active ? " active" : ""}`}>
                    {glyph}
                    {title}
                </div>
            ) : (
                <button
                    className={`agent-row${project ? " two-line" : ""}${active ? " active" : ""}`}
                    onClick={() => cmd.revealAgent(agent.id)}
                    onDoubleClick={onDoubleClick}
                    onContextMenu={onContextMenu}>
                    {glyph}
                    <span className="agent-row-text">
                        <span className="agent-title">
                            <AgentLabel agent={agent} />
                        </span>
                        {project && <AgentRowProject name={project.name} />}
                    </span>
                    <BackgroundCounts display={display} />
                    <Collided agentId={agent.id} />
                </button>
            )}
            {showsAgentState(display) && (
                <span className="row-status">
                    <AgentStateIndicator display={display} />
                </span>
            )}
            <Tooltip label={`Close ${agent.title}`}>
                <button type="button" className="row-x" aria-label={`Close ${agent.title}`} onClick={() => cmd.closeAgent(agent.id)}>
                    <IconClose size={11} />
                </button>
            </Tooltip>
            <AgentRowTree agentId={agent.id} worktree={agent.worktree} runsOn={link === "head" || link === "member"} />
        </div>
    );
}

import { useLayoutEffect, useMemo, useRef } from "react";
import { AgentStateIndicator, BackgroundCounts, showsAgentState } from "../agents/AgentStateIndicator";
import { blockingQuestion } from "../agents/agentQuestions";
import * as cmd from "../state/commands";
import { useStore } from "../state/store";
import { inTeams, type TeamLink } from "../agents/teams";
import { AGENT_GROUPS, AGENT_LABELS, lastWorkedAt, type AgentDisplay, type AgentGroup } from "../state/agentStatus";
import { activeAgentId, agentDisplayOf, openAgents } from "../state/selectors";
import type { Agent } from "../state/types";
import { AgentIcon, IconClose } from "../ui/Icons";
import { Panel, PanelHeader } from "../ui/Panel";
import { Tooltip } from "../ui/Tooltip";
import { AgentAskingLabel } from "./AgentAskingLabel";
import { AgentRowTree } from "./AgentRowTree";
import { drawTeamLines } from "./teams";

interface OpenAgentRow {
    id: string;
    lead?: string;
    agent: Agent;
    display: AgentDisplay;
    sessionName: string;
    sessionId: string;
}

/** Every agent open in any project, grouped by what it needs from you. */
export function AllProjectsAgents() {
    const sessionOrder = useStore((s) => s.sessionOrder);
    const sessions = useStore((s) => s.sessions);
    const windows = useStore((s) => s.windows);
    const windowsBySession = useStore((s) => s.windowsBySession);
    const agents = useStore((s) => s.agents);
    const agentActivity = useStore((s) => s.agentActivity);
    const agentTasks = useStore((s) => s.agentTasks);
    const agentSubagents = useStore((s) => s.agentSubagents);
    const questions = useStore((s) => s.agentQuestions);
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

    const groups = useMemo(() => {
        const listed = new Map(open.map((row) => [row.id, row]));
        const headOf = (row: OpenAgentRow): OpenAgentRow => {
            let head = row;
            for (let steps = 0; steps < listed.size; steps++) {
                const lead = head.lead ? listed.get(head.lead) : undefined;
                if (!lead) break;
                head = lead;
            }
            return head;
        };
        // A team sits in its first lead's group so it stays together; one of its agents waiting on you also shows in
        // Needs input on a row of its own.
        const sectionOf = (row: OpenAgentRow): AgentGroup => headOf(row).display.group;
        return AGENT_GROUPS.map((id) => {
            const rows = open.filter((row) => sectionOf(row) === id);
            if (id === "done" || id === "idle") rows.sort((x, y) => lastWorkedAt(agentActivity[y.id]) - lastWorkedAt(agentActivity[x.id]));
            const teams: { row: OpenAgentRow; link?: TeamLink }[] = inTeams(rows).map(({ agent, link }) => ({ row: agent, link }));
            if (id === "blocked") {
                for (const row of open) if (sectionOf(row) !== id && row.display.group === id) teams.push({ row });
            }
            return { id, teams };
        });
    }, [open, agentActivity]);

    const root = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
        if (root.current) drawTeamLines(root.current);
    });

    if (open.length === 0) return <div className="agent-empty">no agents open in any project</div>;

    return (
        <div ref={root} className="agent-all-projects">
            {groups.map(({ id, teams }) => {
                if (teams.length === 0) return null;
                return (
                    <Panel key={id} variant="group" className={`agent-group${id === "blocked" ? " agent-attention" : ""}`}>
                        <PanelHeader label={`${AGENT_LABELS[id]} ${teams.length}`} rule />
                        {teams.map(({ row: { agent, display, sessionName, sessionId }, link }) => {
                            const question = id === "blocked" ? blockingQuestion(questions, agent.id) : undefined;
                            return (
                                <div
                                    key={agent.id}
                                    className={`agent-row-wrap${link === "head" ? " chain-head" : link ? ` chain${link === "last" ? " chain-last" : ""}` : ""}`}>
                                    <button
                                        className={`agent-row${question ? " asking" : ""}${agent.id === shownAgentId ? " active" : ""}`}
                                        title={`${sessionName} — ${agent.title}${question ? `: ${question.text}` : ""}`}
                                        onClick={() => cmd.revealAgent(agent.id)}>
                                        <span className={`agent-glyph ${agent.type}`}>
                                            <AgentIcon type={agent.type} size={20} />
                                        </span>
                                        <AgentAskingLabel agent={agent} line={question?.text ?? null} />
                                        <BackgroundCounts display={display} />
                                    </button>
                                    {showsAgentState(display) && (
                                        <span className="row-status">
                                            <AgentStateIndicator display={display} />
                                        </span>
                                    )}
                                    <Tooltip label={`Close ${agent.title}`}>
                                        <button
                                            type="button"
                                            className="row-x"
                                            aria-label={`Close ${agent.title}`}
                                            onClick={() => cmd.closeAgent(agent.id)}>
                                            <IconClose size={11} />
                                        </button>
                                    </Tooltip>
                                    <AgentRowTree
                                        agentId={agent.id}
                                        project={{ name: sessionName, sessionId }}
                                        worktree={agent.worktree}
                                        runsOn={link === "head" || link === "member"}
                                    />
                                </div>
                            );
                        })}
                    </Panel>
                );
            })}
        </div>
    );
}

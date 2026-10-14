import { AgentLabel } from "../agents/AgentLabel";
import type { Agent } from "../state/types";

/** A rail row's label, with what the agent asks the person, or went on assuming, under its name. */
export function AgentAskingLabel({ agent, line }: { agent: Agent; line: string | null }) {
    const label = (
        <span className="agent-title">
            <AgentLabel agent={agent} />
        </span>
    );
    if (line === null) return label;
    return (
        <span className="agent-asking">
            {label}
            <span className="agent-question">{line}</span>
        </span>
    );
}

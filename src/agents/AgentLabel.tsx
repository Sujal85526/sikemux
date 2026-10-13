import type { Agent } from "../state/types";

/** An agent as its rail row and header show it: its name, then what it is working on, dimmed. */
export function AgentLabel({ agent }: { agent: Pick<Agent, "name" | "title"> }) {
    if (!agent.name) return <>{agent.title}</>;
    return (
        <>
            <span className="agent-name">{agent.name}</span>
            <span className="agent-name-sep">·</span>
            <span className="agent-name-title">{agent.title}</span>
        </>
    );
}

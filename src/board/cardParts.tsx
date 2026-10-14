import { AgentMark } from "../agents/AgentMark";
import { AgentStateIndicator } from "../agents/AgentStateIndicator";
import { agentDisplay } from "../state/agentStatus";
import { useStore } from "../state/store";

/** An agent as a card names it: its mark, its name and what it is doing now. */
export function Owner({ id, name, cli }: { id: string; name: string | null; cli: string | null }) {
    const agent = useStore((s) => s.agents[id]);
    const state = useStore((s) => s.agentActivity[id]?.state);
    const display = agent && agent.launchState !== "dormant" ? agentDisplay(state) : null;
    return (
        <span className="board-owner">
            <AgentMark cli={agent?.type ?? cli} />
            <b>{agent?.name ?? name ?? "An agent"}</b>
            {display && <AgentStateIndicator display={display} />}
        </span>
    );
}

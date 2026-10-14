import type { BoardCard } from "../agents/agentBoard";
import { AgentStateIndicator } from "../agents/AgentStateIndicator";
import { isAgentType } from "../agents/catalog";
import { agentDisplay } from "../state/agentStatus";
import { useStore } from "../state/store";
import { AgentIcon } from "../ui/Icons";

/** The first words of a title, for a chip that points at the card. */
export const shortTitle = (title: string): string => {
    const words = title.split(/\s+/);
    return words.length > 3 ? `${words.slice(0, 3).join(" ")}…` : title;
};

/** The ticket a card is filed under: its own, or the nearest card above it that has one. */
export function ticketAbove(card: BoardCard, byId: ReadonlyMap<number, BoardCard>): string | null {
    let current = card.parent === null ? undefined : byId.get(card.parent);
    for (let steps = 0; current && steps < byId.size; steps += 1) {
        if (current.ticket) return current.ticket.key;
        current = current.parent === null ? undefined : byId.get(current.parent);
    }
    return null;
}

export function AgentMark({ cli, size = 14 }: { cli: string | null | undefined; size?: number }) {
    return cli && isAgentType(cli) ? <AgentIcon type={cli} size={size} className={`agent-glyph ${cli}`} /> : null;
}

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

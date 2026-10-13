import { useMemo } from "react";
import { agentLabel } from "../agents/catalog";
import type { PromptContext } from "../api/acp";
import { MENTION_URI } from "./promptContext";
import { agentDisplay } from "../state/agentStatus";
import { agentIdsOf, agentWindowId, ownerSessionId } from "../state/selectors";
import { useStore } from "../state/store";
import type { AgentType } from "../state/types";

/** Another agent of the project, as the composer offers it after `@`. */
export interface Mate {
    id: string;
    name: string;
    type: AgentType;
    title: string;
    status: string;
}

/** The project's other named agents, in strip order. */
export function useMates(agentId: string): Mate[] {
    const agents = useStore((s) => s.agents);
    const windows = useStore((s) => s.windows);
    const windowsBySession = useStore((s) => s.windowsBySession);
    const sessionOrder = useStore((s) => s.sessionOrder);
    const activity = useStore((s) => s.agentActivity);
    return useMemo(() => {
        const windowId = agentWindowId({ windows }, agentId);
        const sessionId = windowId ? ownerSessionId({ sessionOrder, windowsBySession }, windowId) : null;
        if (!sessionId) return [];
        return agentIdsOf({ windows, windowsBySession }, sessionId).flatMap((id) => {
            const agent = agents[id];
            if (!agent?.name || id === agentId) return [];
            const status = agent.launchState === "dormant" ? "Asleep" : agentDisplay(activity[id]?.state).label;
            return [{ id, name: agent.name, type: agent.type, title: agent.title, status }];
        });
    }, [agentId, agents, windows, windowsBySession, sessionOrder, activity]);
}

export function matchMates(mates: readonly Mate[], needle: string, limit: number): Mate[] {
    const wanted = needle.toLowerCase();
    if (!wanted) return [];
    return mates.filter((mate) => mate.name.toLowerCase().startsWith(wanted)).slice(0, limit);
}

/** What the agent is told of each agent the message names with `@`, so it knows who is meant and how to reach them. */
export function mentionContext(text: string, mates: readonly Mate[]): PromptContext[] {
    const named = new Set([...text.matchAll(/(?:^|\s)@([\p{L}][\p{L}\p{N}_-]*)/gu)].map((match) => match[1].toLowerCase()));
    return mates
        .filter((mate) => named.has(mate.name.toLowerCase()))
        .map((mate) => ({
            uri: `${MENTION_URI}${mate.id}`,
            title: `@${mate.name}`,
            text: [
                `@${mate.name} is another agent in this project, not the person.`,
                `Agent id: ${mate.id}`,
                `CLI: ${agentLabel(mate.type)}`,
                `Status: ${mate.status}`,
                `Working on: ${mate.title}`,
                `Reach it with Sikemux's agent tools (agent_send, agent_read, agent_wait) by its name or id.`,
            ].join("\n"),
        }));
}

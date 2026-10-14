import { useMemo } from "react";
import { agentLabel } from "../agents/catalog";
import type { PromptContext } from "../api/acp";
import { MENTION_URI } from "./promptContext";
import { agentDisplay, type AgentDisplay } from "../state/agentStatus";
import { agentIdsOf, agentWindowId, ownerSessionId } from "../state/selectors";
import { useStore } from "../state/store";
import type { AgentType } from "../state/types";

/** Another agent of the project, as the composer offers it after `@`. */
export interface Mate {
    id: string;
    name: string;
    type: AgentType;
    title: string;
    /** How it is shown beside its name; none while it sleeps. */
    display: AgentDisplay | null;
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
            const display = agent.launchState === "dormant" ? null : agentDisplay(activity[id]?.state);
            return [{ id, name: agent.name, type: agent.type, title: agent.title, display }];
        });
    }, [agentId, agents, windows, windowsBySession, sessionOrder, activity]);
}

export function matchMates(mates: readonly Mate[], needle: string, limit: number): Mate[] {
    const wanted = needle.toLowerCase();
    if (!wanted) return [];
    return mates.filter((mate) => mate.name.toLowerCase().startsWith(wanted)).slice(0, limit);
}

/** What the agent is told of each agent the message names with `@`, so it knows who is meant. */
export function mentionContext(text: string, mates: readonly Mate[]): PromptContext[] {
    const named = new Set([...text.matchAll(/(?:^|\s)@([\p{L}][\p{L}\p{N}]*)/gu)].map((match) => match[1].toLowerCase()));
    return mates
        .filter((mate) => named.has(mate.name.toLowerCase()))
        .map((mate) => ({
            uri: `${MENTION_URI}${mate.id}`,
            title: `@${mate.name}`,
            text: [
                `@${mate.name} is another agent in this project, not the person.`,
                `Agent id: ${mate.id}`,
                `CLI: ${agentLabel(mate.type)}`,
                `Status: ${mate.display?.label ?? "Asleep"}`,
                `Working on: ${mate.title}`,
            ].join("\n"),
        }));
}

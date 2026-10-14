import { useEffect, useMemo, useState } from "react";
import { selectedAgentRuntimeProfiles, selectedProviderProfile } from "../agents/agentProfiles";
import { agentLabel } from "../agents/catalog";
import type { PromptContext } from "../api/acp";
import { agentNamesApi } from "../api/agentNames";
import { agentApi, type RecentChat } from "../api/agents";
import { MENTION_URI } from "./promptContext";
import { agentDisplay, type AgentDisplay } from "../state/agentStatus";
import * as cmd from "../state/commands";
import { useResource } from "../state/resources";
import { agentCatalogR } from "../state/resources.defs";
import { agentIdsOf, agentWindowId, ownerSessionId } from "../state/selectors";
import { getState, useStore } from "../state/store";
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

function mateNote(mate: Mate, status: string, earlier?: string): string {
    return [
        `@${mate.name} is another agent in this project, not the person.`,
        ...(earlier ? [`Sikemux opened its earlier chat "${earlier}" again for this message, under this new name.`] : []),
        `Agent id: ${mate.id}`,
        `CLI: ${agentLabel(mate.type)}`,
        `Status: ${status}`,
        `Working on: ${mate.title}`,
        `To message it, call agent_send with to "${mate.name}".`,
    ].join("\n");
}

/** What the agent is told of each agent the message names with `@`, so it knows who is meant. */
export function mentionContext(text: string, mates: readonly Mate[]): PromptContext[] {
    const named = new Set([...text.matchAll(/(?:^|\s)@([\p{L}][\p{L}\p{N}]*)/gu)].map((match) => match[1].toLowerCase()));
    return mates
        .filter((mate) => named.has(mate.name.toLowerCase()))
        .map((mate) => ({ uri: `${MENTION_URI}${mate.id}`, title: `@${mate.name}`, text: mateNote(mate, mate.display?.label ?? "Asleep") }));
}

const EARLIER_LIMIT = 4;
const EARLIER_SETTLE_MS = 150;

/** An earlier chat of the project, offered after `@` by its title; sending the message opens it again. */
export interface EarlierChat {
    chat: RecentChat;
    /** The project it opens in. */
    sessionId: string;
}

/** The project's saved chats whose title holds `needle`, leaving out those open as agents. */
export function useEarlierChats(agentId: string, needle: string | null): EarlierChat[] {
    const profiles = useStore((s) => s.providerProfiles);
    const selections = useStore((s) => s.selectedProviderProfileIds);
    const runtimeProfiles = useMemo(() => selectedAgentRuntimeProfiles(profiles, selections), [profiles, selections]);
    const catalog = useResource(agentCatalogR, runtimeProfiles);
    const providers = useMemo(
        () =>
            (catalog.data ?? [])
                .filter((agent) => agent.available !== false)
                .map((agent) => ({ agent: agent.type, configPath: agent.configPath ?? null })),
        [catalog.data],
    );
    const sessionId = useStore((s) => {
        const windowId = agentWindowId(s, agentId);
        const id = windowId ? ownerSessionId(s, windowId) : null;
        return id && s.sessions[id]?.kind === "project" ? id : null;
    });
    const cwd = useStore((s) => (sessionId ? s.sessions[sessionId]?.cwd || null : null));
    const wanted = needle?.trim().toLowerCase() ?? "";
    const [found, setFound] = useState<{ key: string; chats: EarlierChat[] }>({ key: "", chats: [] });
    const key = JSON.stringify([providers, cwd, wanted]);

    useEffect(() => {
        if (!wanted || !cwd || !sessionId || providers.length === 0) return;
        let current = true;
        const timer = window.setTimeout(() => {
            const exclude = Object.values(getState().agents).map((agent) => ({ agent: agent.type, id: agent.resumeId ?? agent.id }));
            agentApi
                .recent({ providers, projects: [cwd], limit: EARLIER_LIMIT, query: wanted, exclude })
                .then((page) => {
                    if (current) setFound({ key, chats: page.sessions.map((chat) => ({ chat, sessionId })) });
                })
                .catch(() => {
                    if (current) setFound({ key, chats: [] });
                });
        }, EARLIER_SETTLE_MS);
        return () => {
            current = false;
            window.clearTimeout(timer);
        };
    }, [key, wanted, cwd, sessionId, providers]);

    return wanted && found.key === key ? found.chats : [];
}

/** Where a picked earlier chat points until the message is sent. */
export const EARLIER_URI = "sikemux://earlier/";
/** Where an earlier chat opened again for a message points once it has its new name. */
export const WOKEN_URI = "sikemux://woken/";

/**
 * Opens an earlier chat again in a tab behind the one in front, as opening it from Recent does, and tells the agent
 * the message goes to who it is now. It gets a new name for this run.
 */
export async function wakeEarlier({ chat, sessionId }: EarlierChat): Promise<PromptContext> {
    const state = getState();
    const profileId = selectedProviderProfile(chat.agent, state.providerProfiles, state.selectedProviderProfileIds)?.id;
    if (!cmd.addAgent(chat.agent, chat.id, chat.title, { sessionId, profileId, background: true })) {
        throw new Error(`"${chat.title}" could not be opened again`);
    }
    const agent = Object.values(getState().agents).find((candidate) => candidate.type === chat.agent && candidate.resumeId === chat.id);
    if (!agent) throw new Error(`"${chat.title}" could not be opened again`);
    if (agent.launchState === "dormant") cmd.resumeAgent(agent.id);
    let name = agent.name;
    if (!name) {
        const named = await agentNamesApi.name({ agentId: agent.id, cwd: agent.cwd ?? chat.project, provider: agent.type, resumeId: chat.id });
        cmd.setAgentName(agent.id, named.name, named.parent);
        name = named.name;
    }
    const mate: Mate = { id: agent.id, name, type: agent.type, title: chat.title, display: null };
    return { uri: `${WOKEN_URI}${agent.id}`, title: `@${name} · ${chat.title}`, text: mateNote(mate, "Starting", chat.title) };
}

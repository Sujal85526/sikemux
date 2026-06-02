import { useEffect } from "react";
import { fetchResource } from "../state/resources";
import { agentSessionsR } from "../state/resources.defs";
import { getState, useStore } from "../state/store";
import type { AgentType } from "../state/types";
import * as cmd from "../state/commands";
import { swallow } from "../state/toast";

const FAST_SYNC_MS = 2_500;
const SLOW_SYNC_MS = 15_000;
const FAST_SYNC_WINDOW_MS = 5 * 60_000;

interface AgentSyncGroup {
    type: AgentType;
    cwd: string;
    fast: boolean;
}

function collectAgentSyncGroups(): AgentSyncGroup[] {
    const st = getState();
    const now = Date.now();
    const groups = new Map<string, AgentSyncGroup>();

    for (const sessionId of st.sessionOrder) {
        const session = st.sessions[sessionId];
        if (session?.kind !== "project" || !session.cwd) continue;
        for (const agentId of st.agentsBySession[sessionId] ?? []) {
            const agent = st.agents[agentId];
            if (!agent) continue;
            const key = `${agent.type}\0${session.cwd}`;
            const group = groups.get(key) ?? { type: agent.type, cwd: session.cwd, fast: false };
            const freshEnough = agent.createdAt == null || now - agent.createdAt < FAST_SYNC_WINDOW_MS;
            if (freshEnough && (!agent.resumeId || agent.title === agent.type)) group.fast = true;
            groups.set(key, group);
        }
    }

    return [...groups.values()];
}

function useAgentSyncKey(): string {
    return useStore((s) => {
        const parts: string[] = [];
        for (const sessionId of s.sessionOrder) {
            const session = s.sessions[sessionId];
            if (session?.kind !== "project" || !session.cwd) continue;
            for (const agentId of s.agentsBySession[sessionId] ?? []) {
                const agent = s.agents[agentId];
                if (!agent) continue;
                parts.push(`${agent.id}:${agent.type}:${session.cwd}:${agent.resumeId ?? ""}:${agent.createdAt ?? 0}`);
            }
        }
        return parts.sort().join("|");
    });
}

export function AgentSessionSync() {
    const syncKey = useAgentSyncKey();

    useEffect(() => {
        let cancelled = false;
        let timer: number | undefined;

        const sync = async () => {
            const groups = collectAgentSyncGroups();
            await Promise.all(
                groups.map((group) =>
                    fetchResource(agentSessionsR, group.type, group.cwd)
                        .then((rows) => cmd.reconcileAgentSessions(group.type, group.cwd, rows))
                        .catch(swallow("agent sessions")),
                ),
            );
            if (cancelled) return;
            const nextGroups = collectAgentSyncGroups();
            if (nextGroups.length === 0) return;
            const delay = nextGroups.some((group) => group.fast) ? FAST_SYNC_MS : SLOW_SYNC_MS;
            timer = window.setTimeout(sync, delay);
        };

        if (syncKey) {
            timer = window.setTimeout(sync, FAST_SYNC_MS);
        }

        return () => {
            cancelled = true;
            if (timer !== undefined) window.clearTimeout(timer);
        };
    }, [syncKey]);

    return null;
}

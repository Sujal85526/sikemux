import { useCallback, useEffect, useRef } from "react";
import { performanceTelemetry } from "../lib/performance";
import * as cmd from "../state/commands";
import { getState, useStore, type StoreState } from "../state/store";

export const AGENT_IDLE_SLEEP_MS = 10 * 60_000;
export const AGENT_SLEEP_POLICY_INTERVAL_MS = 30_000;
export const MAX_WARM_IDLE_AGENTS = 3;

export type HiddenAgentTimes = Map<string, number>;

function visibleAgentId(state: StoreState): string | null {
    const session = state.sessions[state.activeSessionId];
    return session?.view === "agent" ? session.activeAgentId : null;
}

export function reconcileHiddenAgentTimes(state: StoreState, hiddenSince: HiddenAgentTimes, now: number): void {
    const visible = visibleAgentId(state);
    const liveIds = new Set<string>();
    for (const agent of Object.values(state.agents)) {
        if (agent.launchState === "dormant" || agent.id === visible) {
            hiddenSince.delete(agent.id);
            continue;
        }
        liveIds.add(agent.id);
        if (!hiddenSince.has(agent.id)) hiddenSince.set(agent.id, now);
    }
    for (const id of hiddenSince.keys()) {
        if (!liveIds.has(id)) hiddenSince.delete(id);
    }
}

export function agentIdsToAutoSleep(state: StoreState, hiddenSince: HiddenAgentTimes, now: number): string[] {
    const eligible = Object.values(state.agents)
        .flatMap((agent) => {
            const hiddenAt = hiddenSince.get(agent.id);
            const activity = state.agentActivity[agent.id];
            if (
                hiddenAt === undefined ||
                agent.launchState === "dormant" ||
                !agent.resumeId ||
                agent.keepAlive ||
                activity?.backendState !== "idle" ||
                activity.confidence === "low"
            ) {
                return [];
            }
            return [{ id: agent.id, hiddenAt, activityAt: activity.updatedAt }];
        })
        .sort((left, right) => left.hiddenAt - right.hiddenAt || left.activityAt - right.activityAt || left.id.localeCompare(right.id));

    const sleeping = new Set(eligible.filter((agent) => now - agent.hiddenAt >= AGENT_IDLE_SLEEP_MS).map((agent) => agent.id));
    const warm = eligible.filter((agent) => !sleeping.has(agent.id));
    const overflow = Math.max(0, warm.length - MAX_WARM_IDLE_AGENTS);
    for (const agent of warm.slice(0, overflow)) sleeping.add(agent.id);
    return [...sleeping];
}

export function AgentLifecycleManager() {
    const activeSessionId = useStore((state) => state.activeSessionId);
    const sessions = useStore((state) => state.sessions);
    const agents = useStore((state) => state.agents);
    const agentsBySession = useStore((state) => state.agentsBySession);
    const agentActivity = useStore((state) => state.agentActivity);
    const hiddenSinceRef = useRef<HiddenAgentTimes>(new Map());

    const enforcePolicy = useCallback(() => {
        const state = getState();
        const now = Date.now();
        reconcileHiddenAgentTimes(state, hiddenSinceRef.current, now);
        const sleeping = agentIdsToAutoSleep(state, hiddenSinceRef.current, now);
        const slept = cmd.sleepAgents(sleeping);
        if (slept.length > 0) performanceTelemetry.incrementCounter("agent.sleep.auto", slept.length);
    }, []);

    useEffect(enforcePolicy, [activeSessionId, sessions, agents, agentsBySession, agentActivity, enforcePolicy]);

    useEffect(() => {
        const timer = window.setInterval(enforcePolicy, AGENT_SLEEP_POLICY_INTERVAL_MS);
        return () => window.clearInterval(timer);
    }, [enforcePolicy]);

    return null;
}

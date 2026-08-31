import { createElement } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getState, setState } from "../state/store";
import {
    AGENT_IDLE_SLEEP_MS,
    MAX_WARM_IDLE_AGENTS,
    AgentLifecycleManager,
    agentIdsToAutoSleep,
    reconcileHiddenAgentTimes,
    type HiddenAgentTimes,
} from "./AgentLifecycleManager";

const initial = getState();

beforeEach(() => {
    vi.useRealTimers();
    setState(initial, true);
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

function arrangeAgents(count: number) {
    const state = getState();
    const sessionId = state.activeSessionId;
    const agents = Object.fromEntries(
        Array.from({ length: count }, (_, index) => {
            const id = `agent-${index}`;
            return [
                id,
                {
                    id,
                    type: "codex" as const,
                    title: id,
                    startup: "codex",
                    resumeId: `session-${index}`,
                    launchState: "live" as const,
                },
            ];
        }),
    );
    const agentActivity = Object.fromEntries(
        Object.keys(agents).map((id, index) => [
            id,
            {
                state: "idle" as const,
                backendState: "idle" as const,
                unread: false,
                updatedAt: index,
                sequence: 1,
                source: "screen" as const,
                confidence: "high" as const,
                reason: "prompt visible",
            },
        ]),
    );
    setState({
        sessions: { ...state.sessions, [sessionId]: { ...state.sessions[sessionId], kind: "project", view: "windows", activeAgentId: null } },
        agents,
        agentsBySession: { ...state.agentsBySession, [sessionId]: Object.keys(agents) },
        agentActivity,
    });
}

describe("agent sleep policy", () => {
    it("enforces the timeout while mounted", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        arrangeAgents(1);
        render(createElement(AgentLifecycleManager));

        await act(async () => vi.advanceTimersByTimeAsync(AGENT_IDLE_SLEEP_MS));

        expect(getState().agents["agent-0"].launchState).toBe("dormant");
    });

    it("sleeps a hidden resumable agent after the idle timeout", () => {
        arrangeAgents(1);
        const now = 1_000_000;
        const hiddenSince: HiddenAgentTimes = new Map([["agent-0", now - AGENT_IDLE_SLEEP_MS]]);
        expect(agentIdsToAutoSleep(getState(), hiddenSince, now)).toEqual(["agent-0"]);
    });

    it("bounds hidden warm idle agents by least-recent use", () => {
        arrangeAgents(MAX_WARM_IDLE_AGENTS + 2);
        const hiddenSince: HiddenAgentTimes = new Map(Object.keys(getState().agents).map((id, index) => [id, 100 + index] as const));
        expect(agentIdsToAutoSleep(getState(), hiddenSince, 1_000)).toEqual(["agent-0", "agent-1"]);
    });

    it("preserves visible, unsafe, unresumable, and kept-awake agents", () => {
        arrangeAgents(5);
        const state = getState();
        const sessionId = state.activeSessionId;
        setState((current) => ({
            sessions: {
                ...current.sessions,
                [sessionId]: { ...current.sessions[sessionId], view: "agent", activeAgentId: "agent-0" },
            },
            agents: {
                ...current.agents,
                "agent-1": { ...current.agents["agent-1"], keepAlive: true },
                "agent-2": { ...current.agents["agent-2"], resumeId: undefined },
            },
            agentActivity: {
                ...current.agentActivity,
                "agent-3": { ...current.agentActivity["agent-3"], backendState: "working", state: "working" },
                "agent-4": { ...current.agentActivity["agent-4"], confidence: "low" },
            },
        }));
        const hiddenSince: HiddenAgentTimes = new Map(Object.keys(getState().agents).map((id) => [id, 0]));
        reconcileHiddenAgentTimes(getState(), hiddenSince, AGENT_IDLE_SLEEP_MS);
        expect(agentIdsToAutoSleep(getState(), hiddenSince, AGENT_IDLE_SLEEP_MS * 2)).toEqual([]);
        expect(hiddenSince.has("agent-0")).toBe(false);
    });

    it("drops stale and sleeping entries from hidden-time tracking", () => {
        arrangeAgents(2);
        setState((state) => ({
            agents: { ...state.agents, "agent-1": { ...state.agents["agent-1"], launchState: "dormant" } },
        }));
        const hiddenSince: HiddenAgentTimes = new Map([
            ["agent-0", 10],
            ["agent-1", 10],
            ["removed", 10],
        ]);
        reconcileHiddenAgentTimes(getState(), hiddenSince, 20);
        expect([...hiddenSince]).toEqual([["agent-0", 10]]);
    });
});

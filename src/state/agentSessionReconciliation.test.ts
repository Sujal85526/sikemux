import { beforeEach, describe, expect, it } from "vitest";
import { agentSessionMetadataPending, reconcileAgentSessions, noteAcpAgentState } from "./commands";
import { getState, setState } from "./store";
import { agentWindowId } from "./selectors";
import { withAgents } from "../test/agents";

const initial = getState();

beforeEach(() => setState(initial, true));

describe("agent session reconciliation", () => {
    it("replaces a generic title when the provider session title reaches disk", () => {
        const state = getState();
        const sessionId = state.activeSessionId;
        const agentId = "agent-new";
        const transcriptId = "019fd81d-c861-7920-bc88-a41a6b17aca4";
        const slices = withAgents(state, sessionId, [
            { id: agentId, type: "codex", title: "codex", startup: "codex", createdAt: 100_000, baselineSessionIds: [], launchState: "live" },
        ]);
        setState({
            ...slices,
            sessions: {
                ...state.sessions,
                [sessionId]: { ...state.sessions[sessionId], kind: "project", cwd: "/repo", activeWindowId: agentWindowId(slices, agentId)! },
            },
        });

        reconcileAgentSessions("codex", "/repo", undefined, [{ id: transcriptId, title: transcriptId.slice(0, 8), mtime: 101 }]);
        expect(getState().agents[agentId]).toMatchObject({ resumeId: transcriptId, title: "codex" });
        expect(agentSessionMetadataPending(getState().agents[agentId])).toBe(true);

        reconcileAgentSessions("codex", "/repo", undefined, [{ id: transcriptId, title: "Hello", mtime: 102 }]);
        expect(getState().agents[agentId]).toMatchObject({ resumeId: transcriptId, title: "Hello" });
        expect(agentSessionMetadataPending(getState().agents[agentId])).toBe(false);
    });
    it("does not guess a transcript for an ACP session", () => {
        const state = getState();
        const sessionId = state.activeSessionId;
        const agentId = "acp-new";
        setState({
            sessions: { ...state.sessions, [sessionId]: { ...state.sessions[sessionId], kind: "project", cwd: "/repo" } },
            ...withAgents(state, sessionId, [
                { id: agentId, type: "codex", title: "codex", startup: "codex", createdAt: 100_000, baselineSessionIds: [] },
            ]),
        });
        noteAcpAgentState(agentId, "working");
        reconcileAgentSessions("codex", "/repo", undefined, [{ id: "another-session", title: "Another chat", mtime: 101 }]);
        expect(getState().agents[agentId].resumeId).toBeUndefined();
        expect(getState().agentActivity[agentId]).toMatchObject({ backendState: "working", source: "acp", confidence: "high" });
        noteAcpAgentState(agentId, "blocked");
        expect(getState().agentActivity[agentId].backendState).toBe("blocked");
        noteAcpAgentState(agentId, "idle");
        expect(getState().agentActivity[agentId]).toMatchObject({ state: "done", unread: true });
    });
});

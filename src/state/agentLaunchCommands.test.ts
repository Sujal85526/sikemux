import { beforeEach, describe, expect, it } from "vitest";
import { addAgent, saveProviderProfile, toggleAgentSkipPermissions } from "./commands";
import { getState, setState } from "./store";

const initial = getState();

beforeEach(() => {
    setState(initial, true);
    const session = {
        id: "project",
        name: "project",
        kind: "project" as const,
        cwd: "/code/project",
        deploy: null,
        pinned: false,
        activeWindowId: "window",
        activeAgentId: null,
        view: "windows" as const,
    };
    setState({
        sessions: { project: session },
        sessionOrder: ["project"],
        activeSessionId: "project",
        agents: {},
        agentsBySession: { project: [] },
    });
});

describe("agent launch commands", () => {
    it("clears a default selection when a custom profile changes provider", () => {
        setState({
            providerProfiles: [{ id: "local", name: "Local", provider: "claude", accent: "#abcdef" }],
            selectedProviderProfileIds: { claude: "local" },
        });

        saveProviderProfile({ id: "local", name: "Local Codex", provider: "codex", accent: "#abcdef" });

        expect(getState().selectedProviderProfileIds.claude).toBeUndefined();
    });

    it("does not attach a mismatched provider profile to a launch", () => {
        setState({ providerProfiles: [{ id: "codex-only", name: "Codex", provider: "codex", accent: "#abcdef", executablePath: "/bin/codex" }] });

        addAgent("claude", undefined, undefined, { profileId: "codex-only", permissionMode: "workspace-write" });

        const agent = getState().agents[getState().agentsBySession.project[0]];
        expect(agent.profileId).toBeUndefined();
        expect(agent.startup).toMatch(/^claude /);
    });

    it("normalizes unenforceable modes to an explicit provider default", () => {
        addAgent("pi", undefined, undefined, { permissionMode: "read-only" });

        const agent = getState().agents[getState().agentsBySession.project[0]];
        expect(agent.permissionMode).toBe("full-access");
        expect(agent.startup).toBe("pi");
    });

    it("pins an asynchronous launch to its originating project", () => {
        const other = { ...getState().sessions.project, id: "other", cwd: "/code/other", name: "other" };
        setState((state) => ({
            sessions: { ...state.sessions, other },
            sessionOrder: ["project", "other"],
            activeSessionId: "other",
            agentsBySession: { ...state.agentsBySession, other: [] },
        }));

        const attached = addAgent("codex", undefined, undefined, { sessionId: "project", cwd: "/code/project-lane" });

        expect(attached).toBe(true);
        expect(getState().agentsBySession.project).toHaveLength(1);
        expect(getState().agentsBySession.other).toHaveLength(0);
        expect(getState().activeSessionId).toBe("other");
    });

    it("launches the first task with model, effort, and lazy isolation without pre-creating a branch", () => {
        addAgent("codex", undefined, "Repair parser", {
            model: "gpt-5.6-codex",
            effort: "high",
            initialPrompt: "Repair the parser race.",
            workspaceStrategy: "agent-decides",
            baselineSessionIds: ["existing-one", "existing-two"],
        });

        const agent = getState().agents[getState().agentsBySession.project[0]];
        expect(agent).toMatchObject({
            model: "gpt-5.6-codex",
            effort: "high",
            workspaceStrategy: "agent-decides",
            cwd: "/code/project",
        });
        expect(agent.worktreePath).toBeUndefined();
        expect(agent.baselineSessionIds).toEqual(["existing-one", "existing-two"]);
        expect(agent.firstTurnPending).toBe(true);
        expect(agent.startup).toContain("--model gpt-5.6-codex");
        expect(agent.startup).toContain("model_reasoning_effort");
        expect(agent.startup).toContain("Repair the parser race.");
        expect(agent.startup).toContain("Create an isolated Git worktree only if concurrent work");
    });

    it("preserves the first task for interactive CLIs that cannot receive it in argv", () => {
        addAgent("hermes", undefined, "Hermes task", {
            initialPrompt: "Inspect the local state machine.",
            workspaceStrategy: "current",
        });

        const agent = getState().agents[getState().agentsBySession.project[0]];
        expect(agent.initialPromptSubmitted).toBe(false);
        expect(agent.firstTurnPending).toBe(true);
        expect(agent.initialInput).toContain("Inspect the local state machine.");
        expect(agent.startup).not.toContain("Inspect the local state machine.");
    });

    it("does not restart a one-shot first turn before its resumable session is known", () => {
        addAgent("codex", undefined, "Running task", { initialPrompt: "Keep this turn alive." });
        const id = getState().agentsBySession.project[0];
        const before = getState().agents[id];

        toggleAgentSkipPermissions(id);

        expect(getState().agents[id].permissionMode).toBe(before.permissionMode);
        expect(getState().agents[id].startup).toBe(before.startup);
    });
});

import { beforeEach, describe, expect, it } from "vitest";
import {
    addAgent,
    clearAgentInitialInput,
    closeAgentPalette,
    focusAgents,
    saveProviderProfile,
    setAgentPermissionMode,
    toggleAgentSkipPermissions,
} from "./commands";
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
    it("opens the new-agent draft when entering an empty project's agent view", () => {
        focusAgents();

        expect(getState().sessions.project.view).toBe("agent");
        expect(getState().agentPaletteOpen).toBe(true);

        closeAgentPalette();
        expect(getState().agentPaletteOpen).toBe(false);
    });

    it("focuses an existing agent without opening a new-agent draft", () => {
        addAgent("codex");
        setState((state) => ({
            sessions: { ...state.sessions, project: { ...state.sessions.project, view: "windows" } },
        }));

        focusAgents();

        expect(getState().sessions.project.view).toBe("agent");
        expect(getState().sessions.project.activeAgentId).toBe(getState().agentsBySession.project[0]);
        expect(getState().agentPaletteOpen).toBe(false);
    });

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

    it("normalizes legacy modes to Normal", () => {
        addAgent("pi", undefined, undefined, { permissionMode: "read-only" });

        const agent = getState().agents[getState().agentsBySession.project[0]];
        expect(agent.permissionMode).toBe("workspace-write");
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

    it("launches the first task with model and effort without rewriting the prompt", () => {
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
        expect(agent.startup).not.toContain("Repair the parser race.");
        expect(agent.initialInput).toBe("Repair the parser race.");
        expect(agent.initialInput).not.toContain("Workspace instruction");
    });

    it("preserves the first task for interactive CLIs that cannot receive it in argv", () => {
        addAgent("hermes", undefined, "Hermes task", {
            initialPrompt: "Inspect the local state machine.",
            workspaceStrategy: "current",
        });

        const agent = getState().agents[getState().agentsBySession.project[0]];
        expect(agent.initialPromptSubmitted).toBe(true);
        expect(agent.firstTurnPending).toBe(true);
        expect(agent.initialInput).toContain("Inspect the local state machine.");
        expect(agent.startup).not.toContain("Inspect the local state machine.");
    });

    it("keeps dropped images runtime-only until the first turn is delivered", () => {
        expect(
            addAgent("codex", undefined, "Compare screenshots", {
                initialPrompt: "Spot the regression.",
                initialDropPaths: ["/tmp/before image.png", "/tmp/after.jpg", "/tmp/before image.png"],
            }),
        ).toBe(true);
        const id = getState().agentsBySession.project[0];
        expect(getState().agents[id]).toMatchObject({
            initialDropPaths: ["/tmp/before image.png", "/tmp/after.jpg"],
            initialInput: "Spot the regression.",
            initialPromptSubmitted: true,
            firstTurnPending: true,
        });

        clearAgentInitialInput(id);

        expect(getState().agents[id].initialDropPaths).toBeUndefined();
        expect(getState().agents[id].initialInput).toBeUndefined();
    });

    it("rejects an unsafe or oversized native-drop payload", () => {
        expect(addAgent("codex", undefined, undefined, { initialDropPaths: ["/tmp/safe.png", "/tmp/unsafe\0.png"] })).toBe(false);
        expect(
            addAgent("codex", undefined, undefined, {
                initialDropPaths: Array.from({ length: 9 }, (_, index) => `/tmp/image-${index}.png`),
            }),
        ).toBe(false);
        expect(getState().agentsBySession.project).toHaveLength(0);
    });

    it("does not restart a one-shot first turn before its resumable session is known", () => {
        addAgent("codex", undefined, "Running task", { initialPrompt: "Keep this turn alive." });
        const id = getState().agentsBySession.project[0];
        const before = getState().agents[id];

        toggleAgentSkipPermissions(id);

        expect(getState().agents[id].permissionMode).toBe(before.permissionMode);
        expect(getState().agents[id].startup).toBe(before.startup);
    });

    it("relaunches a resumable session in Normal or YOLO mode", () => {
        addAgent("codex", "session-42", "Resumable task", { permissionMode: "workspace-write" });
        const id = getState().agentsBySession.project[0];

        setAgentPermissionMode(id, "bypass");
        expect(getState().agents[id]).toMatchObject({ permissionMode: "bypass", skipPermissions: true });
        expect(getState().agents[id].directCommand?.args).toEqual(["resume", "--dangerously-bypass-approvals-and-sandbox", "session-42"]);

        setAgentPermissionMode(id, "workspace-write");
        expect(getState().agents[id]).toMatchObject({ permissionMode: "workspace-write", skipPermissions: false });
        expect(getState().agents[id].directCommand?.args).toEqual(["resume", "--sandbox", "workspace-write", "session-42"]);
    });

    it("refuses an explicit mode change until the conversation can be resumed", () => {
        addAgent("claude", undefined, "Fresh task", { permissionMode: "workspace-write" });
        const id = getState().agentsBySession.project[0];
        const before = getState().agents[id];

        setAgentPermissionMode(id, "read-only");

        expect(getState().agents[id].permissionMode).toBe(before.permissionMode);
        expect(getState().agents[id].directCommand).toEqual(before.directCommand);
    });
});

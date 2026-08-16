import { beforeEach, describe, expect, it } from "vitest";
import { addAgent, closeAgentPalette, focusAgents, saveProviderProfile, setAgentPermissionMode } from "./commands";
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
    it("enters an empty project's agent view without opening input UI", () => {
        focusAgents();

        expect(getState().sessions.project.view).toBe("agent");
        expect(getState().agentPaletteOpen).toBe(false);

        closeAgentPalette();
        expect(getState().agentPaletteOpen).toBe(false);
    });

    it("focuses an existing agent without opening the picker", () => {
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

    it("launches the provider directly with model and effort overrides", () => {
        addAgent("codex", undefined, "Repair parser", {
            model: "gpt-5.6-codex",
            effort: "high",
            baselineSessionIds: ["existing-one", "existing-two"],
        });

        const agent = getState().agents[getState().agentsBySession.project[0]];
        expect(agent).toMatchObject({
            model: "gpt-5.6-codex",
            effort: "high",
            cwd: "/code/project",
        });
        expect(agent.baselineSessionIds).toEqual(["existing-one", "existing-two"]);
        expect(agent.startup).toContain("--model gpt-5.6-codex");
        expect(agent.startup).toContain("model_reasoning_effort");
        expect(agent).not.toHaveProperty("initialInput");
        expect(agent).not.toHaveProperty("worktreePath");
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

    it("relaunches a fresh CLI when its live PTY mode changes", () => {
        addAgent("claude", undefined, "Fresh task", { permissionMode: "workspace-write" });
        const id = getState().agentsBySession.project[0];

        setAgentPermissionMode(id, "bypass");

        expect(getState().agents[id]).toMatchObject({
            permissionMode: "bypass",
            skipPermissions: true,
            directCommand: { program: "claude", args: ["--dangerously-skip-permissions"] },
        });
    });
});

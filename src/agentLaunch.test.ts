import { describe, expect, it } from "vitest";
import {
    agentLaunchArgs,
    defaultAgentBranch,
    defaultWorktreePath,
    initialAgentPrompt,
    isDangerousPermissionMode,
    normalizeAgentEffort,
    normalizePermissionMode,
    permissionArgs,
    permissionCopyForType,
    supportedEfforts,
    supportedPermissionModes,
    supportsInitialPrompt,
} from "./agentLaunch";

describe("agent launch policy", () => {
    it("maps Codex safety modes to explicit sandbox flags", () => {
        expect(permissionArgs("codex", "read-only")).toEqual(["--sandbox", "read-only"]);
        expect(permissionArgs("codex", "workspace-write")).toEqual(["--sandbox", "workspace-write"]);
        expect(permissionArgs("codex", "full-access")).toEqual(["--sandbox", "danger-full-access"]);
        expect(permissionArgs("codex", "bypass")).toEqual(["--dangerously-bypass-approvals-and-sandbox"]);
    });

    it("maps Claude modes without conflating full access and bypass", () => {
        expect(permissionArgs("claude", "read-only")).toEqual(["--permission-mode", "plan"]);
        expect(permissionArgs("claude", "workspace-write")).toEqual(["--permission-mode", "acceptEdits"]);
        expect(permissionArgs("claude", "full-access")).toEqual(["--permission-mode", "default"]);
        expect(permissionArgs("claude", "bypass")).toEqual(["--dangerously-skip-permissions"]);
    });

    it("places generated worktrees outside the repository", () => {
        expect(defaultWorktreePath("/code/sikemux", "agent/codex-1")).toBe("/code/.sikemux-worktrees/sikemux/agent-codex-1");
    });

    it("creates stable branch-shaped defaults and marks only bypass dangerous", () => {
        expect(defaultAgentBranch("codex", new Date(2026, 7, 9, 6, 7, 8, 9))).toBe("agent/codex-20260809060708009");
        expect(isDangerousPermissionMode("full-access")).toBe(false);
        expect(isDangerousPermissionMode("bypass")).toBe(true);
    });

    it("never presents unenforceable boundaries for providers without matching CLI flags", () => {
        expect(supportedPermissionModes("pi")).toEqual(["full-access"]);
        expect(supportedPermissionModes("hermes")).toEqual(["full-access", "bypass"]);
        expect(normalizePermissionMode("opencode", "read-only")).toBe("full-access");
        expect(permissionCopyForType("pi", "full-access").label).toBe("Provider default");
        expect(permissionArgs("pi", "read-only")).toEqual([]);
    });

    it("builds Claude model, effort, permission, resume, and prompt arguments", () => {
        expect(
            agentLaunchArgs("claude", {
                resumeId: "session-1",
                permissionMode: "workspace-write",
                model: " sonnet ",
                effort: "high",
                initialPrompt: "  Repair the parser.  ",
            }),
        ).toEqual(["--model", "sonnet", "--effort", "high", "--permission-mode", "acceptEdits", "--resume", "session-1", "Repair the parser."]);
    });

    it("places Codex resume first and passes reasoning as a config override", () => {
        expect(
            agentLaunchArgs("codex", {
                resumeId: "session-2",
                permissionMode: "read-only",
                model: "gpt-5.6-codex",
                effort: "xhigh",
                initialPrompt: "Review only.",
            }),
        ).toEqual([
            "resume",
            "--model",
            "gpt-5.6-codex",
            "--config",
            'model_reasoning_effort="xhigh"',
            "--sandbox",
            "read-only",
            "session-2",
            "Review only.",
        ]);
    });

    it("uses only flags supported by each local interactive CLI", () => {
        expect(agentLaunchArgs("hermes", { model: "anthropic/claude-sonnet-4.6", effort: "ultra", initialPrompt: "Ignored." })).toEqual([
            "--model",
            "anthropic/claude-sonnet-4.6",
            "--reasoning",
            "ultra",
            "--tui",
        ]);
        expect(agentLaunchArgs("pi", { model: "anthropic/claude-sonnet-4.6", effort: "ultra", initialPrompt: "Build it." })).toEqual([
            "--model",
            "anthropic/claude-sonnet-4.6",
            "--thinking",
            "max",
            "Build it.",
        ]);
        expect(agentLaunchArgs("opencode", { model: "openai/gpt-5", effort: "high", initialPrompt: "Build it." })).toEqual([
            "--model",
            "openai/gpt-5",
            "--prompt",
            "Build it.",
        ]);
    });

    it("reports effort and first-message support without inventing provider capabilities", () => {
        expect(supportedEfforts("claude")).toEqual(["low", "medium", "high", "xhigh", "max"]);
        expect(supportedEfforts("hermes")).toContain("ultra");
        expect(supportedEfforts("opencode")).toEqual([]);
        expect(normalizeAgentEffort("codex", "ultra")).toBe("max");
        expect(normalizeAgentEffort("opencode", "high")).toBeUndefined();
        expect(supportsInitialPrompt("claude")).toBe(true);
        expect(supportsInitialPrompt("hermes")).toBe(false);
    });

    it("adds deterministic checkout guidance only when a task exists", () => {
        expect(initialAgentPrompt(" Ship the local timeline. ", "agent-decides")).toBe(
            "Ship the local timeline.\n\nWorkspace instruction: Start in the current checkout. Create an isolated Git worktree only if concurrent work would make editing here unsafe; choose any worktree details only when isolation is actually needed.",
        );
        expect(initialAgentPrompt("Review it", "current")).toContain("Do not create or switch branches or worktrees");
        expect(initialAgentPrompt("   ", "agent-decides")).toBeUndefined();
    });
});

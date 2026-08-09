import { basename, dirname, joinPath } from "./lib/paths";
import type { AgentEffort, AgentPermissionMode, AgentType, AgentWorkspaceStrategy } from "./state/types";

export interface AgentLaunchOptions {
    resumeId?: string;
    permissionMode?: AgentPermissionMode;
    model?: string;
    effort?: AgentEffort;
    /** Final first message, after any workspace instruction has been added. */
    initialPrompt?: string;
}

export const MAX_AGENT_MODEL_LENGTH = 256;
export const MAX_AGENT_PROMPT_LENGTH = 48 * 1024;

const AGENT_EFFORTS: Readonly<Record<AgentType, readonly AgentEffort[]>> = {
    claude: ["low", "medium", "high", "xhigh", "max"],
    codex: ["low", "medium", "high", "xhigh", "max"],
    hermes: ["low", "medium", "high", "xhigh", "max", "ultra"],
    pi: ["low", "medium", "high", "xhigh", "max"],
    // The interactive OpenCode command has --model and --prompt, but its
    // provider-specific --variant effort flag belongs to `opencode run`.
    opencode: [],
};

const INITIAL_PROMPT_SUPPORT: Readonly<Record<AgentType, boolean>> = {
    claude: true,
    codex: true,
    hermes: false,
    pi: true,
    opencode: true,
};

const WORKSPACE_INSTRUCTIONS: Readonly<Record<AgentWorkspaceStrategy, string>> = {
    current: "Work in the current checkout. Do not create or switch branches or worktrees for this task.",
    existing: "Work in the checkout Sikemux opened for this session. Do not create another branch or worktree.",
    "agent-decides":
        "Start in the current checkout. Create an isolated Git worktree only if concurrent work would make editing here unsafe; choose any worktree details only when isolation is actually needed.",
};

export const AGENT_PERMISSION_MODES: readonly AgentPermissionMode[] = ["read-only", "workspace-write", "full-access", "bypass"];

export function supportedPermissionModes(type: AgentType): readonly AgentPermissionMode[] {
    if (type === "claude" || type === "codex") return AGENT_PERMISSION_MODES;
    if (type === "hermes") return ["full-access", "bypass"];
    return ["full-access"];
}

export function normalizePermissionMode(type: AgentType, mode: AgentPermissionMode): AgentPermissionMode {
    return supportedPermissionModes(type).includes(mode) ? mode : "full-access";
}

export function permissionCopyForType(
    type: AgentType,
    mode: AgentPermissionMode,
): { label: string; detail: string; tone: "safe" | "balanced" | "open" | "danger" } {
    if (type !== "claude" && type !== "codex" && mode === "full-access") {
        return {
            label: "Provider default",
            detail: "This provider does not expose a configurable Sikemux boundary; its own settings apply.",
            tone: "open",
        };
    }
    return AGENT_PERMISSION_COPY[mode];
}

export const AGENT_PERMISSION_COPY: Record<AgentPermissionMode, { label: string; detail: string; tone: "safe" | "balanced" | "open" | "danger" }> = {
    "read-only": {
        label: "Observe",
        detail: "Inspect and plan. Changes require a relaunch with a wider boundary.",
        tone: "safe",
    },
    "workspace-write": {
        label: "Build",
        detail: "Edit inside this workspace while approvals guard wider access.",
        tone: "balanced",
    },
    "full-access": {
        label: "Operate",
        detail: "Use the whole machine, with the provider's approval flow intact.",
        tone: "open",
    },
    bypass: {
        label: "Unattended",
        detail: "Bypass approvals and sandboxing. Use only in an isolated worktree.",
        tone: "danger",
    },
};

function slug(value: string): string {
    return value
        .trim()
        .toLocaleLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 42);
}

export function defaultAgentBranch(type: AgentType, now = new Date()): string {
    const stamp =
        [now.getFullYear(), now.getMonth() + 1, now.getDate(), now.getHours(), now.getMinutes(), now.getSeconds()]
            .map((part) => String(part).padStart(2, "0"))
            .join("") + String(now.getMilliseconds()).padStart(3, "0");
    return `agent/${slug(type) || "agent"}-${stamp}`;
}

export function defaultWorktreePath(repo: string, branch: string): string {
    const repoName = slug(basename(repo)) || "project";
    const lane = slug(branch) || "agent";
    return joinPath(dirname(repo), ".sikemux-worktrees", repoName, lane);
}

export function supportedEfforts(type: AgentType): readonly AgentEffort[] {
    return AGENT_EFFORTS[type];
}

/** Convert the portable effort choice to the closest level the local CLI accepts. */
export function normalizeAgentEffort(type: AgentType, effort?: AgentEffort): AgentEffort | undefined {
    if (!effort) return undefined;
    const supported = supportedEfforts(type);
    if (supported.includes(effort)) return effort;
    if (effort === "ultra" && supported.includes("max")) return "max";
    return undefined;
}

export function supportsInitialPrompt(type: AgentType): boolean {
    return INITIAL_PROMPT_SUPPORT[type];
}

/**
 * Compose the launch task with a stable repository-safety instruction.
 * Empty tasks stay empty so opening an agent never starts a turn by surprise.
 */
export function initialAgentPrompt(prompt: string | undefined, workspaceStrategy: AgentWorkspaceStrategy = "current"): string | undefined {
    const task = prompt?.trim();
    if (!task) return undefined;
    return `${task}\n\nWorkspace instruction: ${WORKSPACE_INSTRUCTIONS[workspaceStrategy]}`;
}

/**
 * Build raw provider argv. Callers remain responsible for shell quoting each
 * token when converting the result into Sikemux's terminal startup string.
 */
export function agentLaunchArgs(type: AgentType, options: AgentLaunchOptions = {}): string[] {
    const model = options.model?.trim();
    const effort = normalizeAgentEffort(type, options.effort);
    const prompt = supportsInitialPrompt(type) ? options.initialPrompt?.trim() : undefined;
    const providerArgs: string[] = [];

    if (model) providerArgs.push("--model", model);
    if (effort) {
        if (type === "claude") providerArgs.push("--effort", effort);
        else if (type === "codex") providerArgs.push("--config", `model_reasoning_effort="${effort}"`);
        else if (type === "hermes") providerArgs.push("--reasoning", effort);
        else if (type === "pi") providerArgs.push("--thinking", effort);
    }
    if (options.permissionMode) providerArgs.push(...permissionArgs(type, options.permissionMode));

    if (type === "codex" && options.resumeId) {
        return ["resume", ...providerArgs, options.resumeId, ...(prompt ? [prompt] : [])];
    }

    const resumeArgs = options.resumeId ? resumeArgsForType(type, options.resumeId) : [];
    if (type === "hermes" && (model || effort)) providerArgs.push("--tui");
    if (type === "opencode" && prompt) return [...providerArgs, ...resumeArgs, "--prompt", prompt];
    return [...providerArgs, ...resumeArgs, ...(prompt ? [prompt] : [])];
}

function resumeArgsForType(type: AgentType, id: string): string[] {
    if (type === "claude" || type === "hermes") return ["--resume", id];
    if (type === "pi" || type === "opencode") return ["--session", id];
    return ["resume", id];
}

/** Provider CLI arguments that represent Sikemux's four portable safety levels. */
export function permissionArgs(type: AgentType, mode: AgentPermissionMode): string[] {
    mode = normalizePermissionMode(type, mode);
    if (type === "codex") {
        if (mode === "bypass") return ["--dangerously-bypass-approvals-and-sandbox"];
        return ["--sandbox", mode === "full-access" ? "danger-full-access" : mode];
    }
    if (type === "claude") {
        if (mode === "bypass") return ["--dangerously-skip-permissions"];
        if (mode === "read-only") return ["--permission-mode", "plan"];
        if (mode === "workspace-write") return ["--permission-mode", "acceptEdits"];
        return ["--permission-mode", "default"];
    }
    if (type === "hermes" && mode === "bypass") return ["--yolo"];
    return [];
}

export function isDangerousPermissionMode(mode: AgentPermissionMode): boolean {
    return mode === "bypass";
}

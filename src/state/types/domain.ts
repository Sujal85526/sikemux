export type SplitDir = "row" | "column";
export type PaneKind = "terminal" | "editor" | "git" | "aws" | "search" | "rundeck" | "bruno";

export interface PaneNode {
    type: "pane";
    id: string;
    cwd: string;
    kind: PaneKind;
    title: string;
    startup?: string;
}

export interface SplitNode {
    type: "split";
    id: string;
    dir: SplitDir;
    children: LayoutNode[];
    sizes: number[];
}

export type LayoutNode = PaneNode | SplitNode;

export type SessionKind = "project" | "command" | "ssh" | "aws" | "rundeck" | "bruno";

export type WindowRole = "term" | "files" | "git" | "search" | "aws" | "rundeck" | "bruno" | "ssh-config" | "named";

export interface Window {
    id: string;
    name: string;
    role: WindowRole;
    root: LayoutNode;
    activePaneId: string;
    fixed?: boolean;
}

export type AgentType = "claude" | "codex" | "hermes" | "pi" | "opencode";

/** The permission boundary applied when starting an agent process. */
export type AgentPermissionMode = "read-only" | "workspace-write" | "full-access" | "bypass";

/** Provider-neutral reasoning levels; unsupported levels are normalized per CLI. */
export type AgentEffort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

/** How the first task should treat repository isolation. */
export type AgentWorkspaceStrategy = "current" | "existing" | "agent-decides";

/** Supported profile backends. Gemini is profile-ready ahead of a dedicated agent tab. */
export type AgentProvider = "claude" | "codex" | "gemini";

/**
 * Durable, non-secret configuration for an agent executable.
 * `environmentKeys` stores names only; credential values remain in the user's
 * shell, provider config, or OS credential store.
 */
export interface ProviderProfile {
    id: string;
    name: string;
    provider: AgentProvider;
    accent: string;
    executablePath?: string;
    configPath?: string;
    environmentKeys?: string[];
}

export type ProviderProfileSelection = Partial<Record<AgentType, string>>;

export const DEFAULT_PROVIDER_PROFILES: readonly ProviderProfile[] = [
    { id: "builtin-claude", name: "Claude", provider: "claude", accent: "#d97757" },
    { id: "builtin-codex", name: "Codex", provider: "codex", accent: "#10a37f" },
    { id: "builtin-gemini", name: "Gemini", provider: "gemini", accent: "#4285f4" },
];

export const DEFAULT_PROVIDER_PROFILE_SELECTION: Readonly<ProviderProfileSelection> = {
    claude: "builtin-claude",
    codex: "builtin-codex",
};

export interface Agent {
    id: string;
    type: AgentType;
    title: string;
    startup: string;
    resumeId?: string;
    createdAt?: number;
    /** Explicit launch boundary. Absent on legacy in-memory records. */
    permissionMode?: AgentPermissionMode;
    /** Non-secret provider profile selected for this launch. */
    profileId?: string;
    /** Effective launch directory, commonly a project worktree. */
    cwd?: string;
    /** Worktree root when this agent owns an isolated Git worktree. */
    worktreePath?: string;
    /** Optional provider model override selected at launch. */
    model?: string;
    /** Optional provider reasoning-effort override selected at launch. */
    effort?: AgentEffort;
    /** Launch-time repository strategy, retained for an honest session summary. */
    workspaceStrategy?: AgentWorkspaceStrategy;
    /** Runtime evidence that the provider received a first task in its launch argv. */
    initialPromptSubmitted?: boolean;
    /** Runtime guard against restarting a one-shot first turn before its session id is known. */
    firstTurnPending?: boolean;
    /** Runtime-only first input for CLIs that cannot accept an interactive prompt in argv. */
    initialInput?: string;
    /** @deprecated Compatibility bridge for snapshots and command builders. */
    skipPermissions?: boolean;
    /**
     * Session ids that already existed when this fresh agent launched. Used to
     * keep it from adopting a pre-existing session during reconciliation —
     * it may only attach to a session file that appeared after launch. Cleared
     * once attached.
     */
    baselineSessionIds?: string[];
    /** Restored tabs stay dormant until the user explicitly resumes them. */
    launchState?: "live" | "dormant";
}

export type AgentBackendState = "unknown" | "working" | "blocked" | "idle" | "stopped";
export type AgentPresentationState = AgentBackendState | "done";

export interface AgentRuntimeState {
    state: AgentPresentationState;
    backendState: AgentBackendState;
    unread: boolean;
    updatedAt: number;
    sequence: number;
    source: "screen" | "activity" | "process" | "fallback";
    confidence: "high" | "medium" | "low";
    reason: string;
    matchedRule?: string;
}

/** Identity Sikemux attaches to every shell it owns. Runtime-only. */
export interface PtyContext {
    sessionId: string;
    sessionName: string;
    sessionKind: SessionKind;
    project?: string;
    windowId?: string;
    paneId?: string;
    agentId?: string;
    agentType?: AgentType;
    initialPromptSubmitted?: boolean;
}

export interface NotificationPreferences {
    enabled: boolean;
    onlyWhenUnfocused: boolean;
    sounds: boolean;
    soundStyle: "soft" | "bright";
    delayMs: number;
    quietHoursEnabled: boolean;
    quietHoursStart: string;
    quietHoursEnd: string;
    mutedAgentTypes: AgentType[];
}

export type RailDensity = "comfortable" | "compact";

/** A resolved Rundeck deploy location for a service: a project plus an env subfolder. */
export interface DeployRef {
    project: string;
    folder: string | null;
}

/**
 * Durable per-session state for a Bruno (API) workspace. Lives on the Session so
 * it persists with the existing `sessions` slice — no persist version bump.
 * Secret var values are entered in-app (not stored in .bru files); `drafts` holds
 * edited-but-unsaved request text keyed by file path.
 */
export interface BrunoSessionState {
    collectionPath: string;
    /** selected environment id per collection root (workspaces hold many collections) */
    selectedEnvs: Record<string, string>;
    secretVars: Record<string, string>;
    drafts: Record<string, string>;
}

export interface Session {
    id: string;
    name: string;
    kind: SessionKind;
    cwd: string;
    /** Selected Rundeck deploy location for this session's service, when picked. */
    deploy?: DeployRef | null;
    /** Bruno (API) workspace state — present only when kind === "bruno". */
    bruno?: BrunoSessionState | null;
    pinned: boolean;
    activeWindowId: string;
    activeAgentId: string | null;
    view: "windows" | "agent";
}

export interface RecentEntry {
    kind: SessionKind;
    name: string;
    cwd: string;
}

export type AwsService = "ecs" | "ec2" | "lambda" | "sqs" | "billing" | "s3";
export const AWS_SERVICES: AwsService[] = ["ecs", "ec2", "lambda", "sqs", "billing", "s3"];

export interface RundeckSettings {
    activeProject: string;
    activeEnvFolder: string | null;
    prodEnvs: string[];
}

export interface ProjectRoot {
    path: string;
    depth: number;
}

export interface PinnedProject {
    path: string;
}

export interface Rect {
    x: number;
    y: number;
    w: number;
    h: number;
}

export interface Divider {
    splitId: string;
    index: number;
    dir: SplitDir;
    rect: Rect;
    at: number;
}

export type FocusDir = "left" | "right" | "up" | "down";

export type PickerMode = "all" | "projects" | "ssh" | "bruno";

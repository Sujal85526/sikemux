export type SplitDir = "row" | "column";
export type PaneKind = "terminal" | "editor" | "git" | "aws" | "search" | "rundeck";

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

export type SessionKind = "project" | "command" | "ssh" | "aws" | "rundeck";

export type WindowRole = "term" | "files" | "git" | "search" | "aws" | "rundeck" | "named";

export interface Window {
    id: string;
    name: string;
    role: WindowRole;
    root: LayoutNode;
    activePaneId: string;
    fixed?: boolean;
}

export type AgentType = "claude" | "codex" | "hermes" | "pi" | "opencode";

export interface Agent {
    id: string;
    type: AgentType;
    title: string;
    startup: string;
    resumeId?: string;
    createdAt?: number;
    skipPermissions?: boolean;
}

export type Env = "dev" | "staging" | "preprod" | "production";
export const ENVS: Env[] = ["dev", "staging", "preprod", "production"];

export interface Session {
    id: string;
    name: string;
    kind: SessionKind;
    cwd: string;
    env: Env;
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

export interface AgentBookmark {
    type: AgentType;
    id: string;
    title: string;
    cwd?: string;
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

export type PickerMode = "all" | "projects" | "ssh";

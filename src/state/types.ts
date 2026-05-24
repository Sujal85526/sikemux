// Domain model — normalised. Sessions, windows, and agents all live in their
// own ID-keyed maps; the Session struct holds metadata only. Layout (pane
// tree) lives inside each Window. View state and remote data live elsewhere
// (state/store.ts → view, state/resources.ts → cache).

// ---- Layout tree --------------------------------------------------------

export type SplitDir = "row" | "column";
export type PaneKind = "terminal" | "editor" | "git" | "aws";

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

// ---- Domain entities ----------------------------------------------------

export type SessionKind = "project" | "command" | "ssh" | "aws";

export interface Window {
  id: string;
  name: string;
  root: LayoutNode;
  activePaneId: string;
  fixed?: boolean;
}

export type AgentType = "claude" | "codex" | "hermes";
export const AGENT_TYPES: AgentType[] = ["claude", "codex", "hermes"];

export interface Agent {
  id: string;
  type: AgentType;
  title: string;
  startup: string;
  resumeId?: string;
}

export type Env = "dev" | "staging" | "preprod" | "production";
export const ENVS: Env[] = ["dev", "staging", "preprod", "production"];

export type SessionView = "windows" | "agent";

export interface Session {
  id: string;
  name: string;
  kind: SessionKind;
  cwd: string;
  env: Env;
  pinned: boolean;
  activeWindowId: string;
  activeAgentId: string | null;
  view: SessionView;
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

// ---- AWS --------------------------------------------------------------

export type AwsService = "ecs" | "ec2" | "lambda" | "sqs" | "billing" | "s3";
export const AWS_SERVICES: AwsService[] = [
  "ecs",
  "ec2",
  "lambda",
  "sqs",
  "billing",
  "s3",
];

// ---- View namespaces (ephemeral; keyed by paneId / sessionId / profile) -

export type PickerMode = "all" | "projects" | "ssh";

export interface LspResults {
  title: string;
  project: string;
  results: { uri: string; line: number; character: number }[];
}

export interface EditorPaneView {
  openTabs: string[];
  activePath: string | null;
  treeWidth: number;
}

export type GitPanel = "files" | "branches" | "commits";

export interface GitPaneView {
  panel: GitPanel;
  selected: Record<GitPanel, number>;
}

export type EcsLevel =
  | { kind: "clusters" }
  | { kind: "services"; cluster: string }
  | {
      kind: "service";
      cluster: string;
      service: string;
      tab: "logs" | "tasks";
      taskFilter?: { taskId: string; stream: string };
    };

// ---- Layout geometry ---------------------------------------------------

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

// ---- Persistence wire shape (version-gated) ----------------------------

export interface PersistedSnapshot {
  version: number;
  sessions: Session[];
  windowsBySession: Record<string, Window[]>;
  agentsBySession: Record<string, Agent[]>;
  sessionOrder: string[];
  activeSessionId: string;
  recent: RecentEntry[];
  agentBookmarks: AgentBookmark[];
  prefs: PersistedPrefs;
  editorViews: Record<string, EditorPaneView>;
}

export interface ProjectRoot {
  path: string;
  /** How many levels of subdirs to enumerate (1 = root + immediate subdirs). */
  depth: number;
}

export interface PersistedPrefs {
  projectRoots: ProjectRoot[];
  themeId: string;
  windowOpacity: number;
  windowBlur: number;
  cloudBrowser: string;
  cloudBrowserShortcut: string;
  awsProfile: string | null;
  awsService: AwsService;
  leftRailOpen: boolean;
  rightRailOpen: boolean;
}

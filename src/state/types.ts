// Domain model — normalised. Sessions, windows, and agents all live in their
// own ID-keyed maps; the Session struct holds metadata only. Layout (pane
// tree) lives inside each Window. View state and remote data live elsewhere
// (state/store.ts → view, state/resources.ts → cache).

// ---- Layout tree --------------------------------------------------------

export type SplitDir = "row" | "column";
export type PaneKind =
  | "terminal"
  | "editor"
  | "git"
  | "aws"
  | "search"
  | "rundeck";

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

export type SessionKind = "project" | "command" | "ssh" | "aws" | "rundeck";

// What a Window *is*, structurally. Replaces magic-string checks on
// `name` (e.g. `name === "term" || /^\d+$/.test(name)`) so display logic
// stops parsing user-visible strings.
//
//   term   — the canonical terminal window in a project, plus Alt+N spawned
//            siblings, plus numbered windows in command sessions
//   files  — project files browser + editor
//   git    — project git pane
//   search — project-wide global search (full pane)
//   aws    — AWS console pane
//   named  — user-named (SSH alias, etc.) — neither a tabbable term nor a
//            structural fixture
export type WindowRole =
  | "term"
  | "files"
  | "git"
  | "search"
  | "aws"
  | "rundeck"
  | "named";

export interface Window {
  id: string;
  name: string;
  role: WindowRole;
  root: LayoutNode;
  activePaneId: string;
  fixed?: boolean;
}

/** Predicate kept for compatibility — but prefer `w.role === "term"`. */
export function isTermRole(role: WindowRole): boolean {
  return role === "term";
}

export type AgentType = "claude" | "codex" | "hermes";
export const AGENT_TYPES: AgentType[] = ["claude", "codex", "hermes"];

export interface Agent {
  id: string;
  type: AgentType;
  title: string;
  startup: string;
  resumeId?: string;
  /** When true, the agent CLI launches with its "skip approval" flag:
   *    claude → --dangerously-skip-permissions
   *    hermes → --yolo
   *    codex  → --dangerously-bypass-approvals-and-sandbox
   *  Toggled at runtime via the shield chip in the agent tab; flipping
   *  the value remounts the PTY (the React key includes it) so the new
   *  startup line takes effect immediately. */
  skipPermissions?: boolean;
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

export interface GlobalSearchView {
  query: string;
  options: {
    caseSensitive: boolean;
    wholeWord: boolean;
    isRegex: boolean;
    include: string;
    exclude: string;
  };
  /** Files the user has manually collapsed in the results panel. */
  collapsed: Record<string, boolean>;
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

// ---- Rundeck ----------------------------------------------------------

export interface RundeckSettings {
  /** Selected Rundeck project in the pane (persisted across launches).
   *  The picker is now a tree sub-rail inside the Rundeck pane offering
   *  every project returned by `rnd_projects` — legacy (dev / staging /
   *  Preprod / production) and product (contractiq / marketingiq /
   *  channeliq) live in the same list with no synthetic env aliasing. */
  activeProject: string;
  /** For product projects only: the env-folder filter (`dev`,
   *  `production`, etc.) the matrix is currently scoped to. `null` =
   *  show every env folder grouped. Always `null` for legacy projects
   *  since their jobs aren't env-nested. */
  activeEnvFolder: string | null;
  /** Envs that require type-to-confirm before triggering a deploy. The
   *  env is derived per-job: legacy = project name; product = first
   *  segment of the job's group (`dev/backend/...` → "dev"). See
   *  `inferEnv` in src/state/rundeckShape.ts. */
  prodEnvs: string[];
}

export type RundeckLevel =
  | { kind: "matrix" }
  | { kind: "service"; env: string; project: string; service: string; jobId: string }
  | {
      kind: "deploy";
      env: string;
      project: string;
      service: string;
      jobId: string;
      branch: string;
    }
  | { kind: "execution"; executionId: number; service: string; project: string };

export interface RundeckView {
  /** Pane-scoped navigation stack so back/forward feels right. */
  stack: RundeckLevel[];
}

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
  rundeck?: RundeckSettings;
}

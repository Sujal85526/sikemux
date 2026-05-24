// Session -> Window -> Pane tree. A project also owns a list of Agents.

export type SplitDir = "row" | "column"; // row = side-by-side, column = stacked

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

export interface WinTab {
  id: string;
  name: string;
  root: LayoutNode;
  activePaneId: string;
  fixed?: boolean;
}

export type SessionKind = "project" | "command" | "ssh" | "aws";

export type AgentType = "claude" | "codex" | "hermes";
export const AGENT_TYPES: AgentType[] = ["claude", "codex", "hermes"];

// A coding agent owned by a project — a CLI running in the project's cwd.
export interface Agent {
  id: string;
  type: AgentType;
  title: string; // display name — the type, or a resumed conversation's title
  startup: string; // the CLI command run in the agent's terminal
  resumeId?: string; // the on-disk session id this agent resumes, if any
}

export type Env = "dev" | "staging" | "preprod" | "production";
export const ENVS: Env[] = ["dev", "staging", "preprod", "production"];

// What the stage shows for a session: its window grid, or an agent terminal.
export type SessionView = "windows" | "agent";

export interface Session {
  id: string;
  name: string;
  kind: SessionKind;
  cwd: string;
  env: Env;
  pinned: boolean; // superpinned — lifted into the global strip
  windows: WinTab[];
  activeWindowId: string;
  agents: Agent[]; // project sessions; empty for command
  activeAgentId: string | null;
  view: SessionView;
}

export interface RecentEntry {
  kind: SessionKind;
  name: string;
  cwd: string;
}

// A bookmarked on-disk agent conversation — favourited for fast resume.
// `cwd` is the project the session belongs to; clicking the bookmark switches
// to (or creates) that project before attaching the agent terminal.
export interface AgentBookmark {
  type: AgentType;
  id: string;
  title: string;
  cwd?: string;
}

export interface PersistedSettings {
  projectRoots: string[];
  themeId: string;
  windowOpacity: number;
  windowBlur?: number;
  cloudBrowser?: string;
  cloudBrowserShortcut?: string;
  awsProfile?: string | null;
  awsService?: string;
}

export interface WorkspaceSnapshot {
  version: number;
  sessions: Session[];
  activeSessionId: string;
  recent: RecentEntry[];
  agentBookmarks: AgentBookmark[];
  leftRailOpen: boolean;
  rightRailOpen: boolean;
  settings?: PersistedSettings;
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

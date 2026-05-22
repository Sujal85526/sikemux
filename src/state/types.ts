// Session -> Window -> Pane tree, mirroring the tmux/sesh model.

export type SplitDir = "row" | "column"; // row = side-by-side, column = stacked

// A leaf in a window's layout tree. One pane == one terminal.
export interface PaneNode {
  type: "pane";
  id: string;
  cwd: string;
  title: string;
  startup?: string; // command run in the pane once the shell is ready
}

// An n-ary split. `sizes` are fractions of the split's axis, summing to 1.
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
}

export type SessionKind = "project" | "command";

export type Env = "dev" | "staging" | "preprod" | "production";
export const ENVS: Env[] = ["dev", "staging", "preprod", "production"];

export interface Session {
  id: string;
  name: string;
  kind: SessionKind;
  cwd: string;
  env: Env;
  windows: WinTab[];
  activeWindowId: string;
}

// Geometry, all in 0..1 fractions of the window area.
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// A draggable boundary between two children of a split.
export interface Divider {
  splitId: string;
  index: number; // boundary sits after children[index]
  dir: SplitDir;
  rect: Rect; // the owning split's rect
  at: number; // boundary position within the split, 0..1
}

export type FocusDir = "left" | "right" | "up" | "down";

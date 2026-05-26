// Ephemeral / view-layer state — keyed by paneId, sessionId, or profile.
// None of this is persisted; if you find yourself wanting to persist a
// field here, add it to `domain.ts` and `persisted.ts` instead.

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

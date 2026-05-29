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

export type GitPanel = "status" | "files" | "branches" | "remotes" | "commits" | "stashes";

export interface GitPaneView {
  panel: GitPanel;
  selected: Record<GitPanel, number>;
  /** When set, the Remotes panel is drilled into that remote's branches
   *  view. `null` = show the flat list of remotes. */
  remoteDrill: string | null;
  /** Per-remote selection index in the drill view. Keyed by remote name
   *  so switching back to a previously-visited remote keeps the cursor
   *  where the user left it. */
  remoteBranchSelected: Record<string, number>;
}

export interface GlobalSearchView {
  query: string;
  /** Replacement string for find-and-replace. Empty = find-only mode. */
  replace: string;
  /** Whether the replace row is expanded in the UI (VSCode-style accordion
   *  toggled by the chevron to the left of the find input). The replace
   *  value itself is kept across collapses so reopening restores typing. */
  replaceOpen: boolean;
  options: {
    caseSensitive: boolean;
    wholeWord: boolean;
    isRegex: boolean;
    include: string;
    exclude: string;
  };
  /** Files the user has manually collapsed in the results panel.
   *  Kept for migration / state hydration — the new threaded layout
   *  doesn't render collapse chevrons but the field is preserved so
   *  older persisted state still parses. */
  collapsed: Record<string, boolean>;
  /** Match the right preview pane is currently displaying. `null` when
   *  no match has been clicked yet (preview pane shows the first hit
   *  by default). */
  selected: { path: string; matchIndex: number } | null;
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
  | { kind: "service"; env: string; project: string; service: string; jobId: string; repoPath?: string }
  | {
      kind: "deploy";
      env: string;
      project: string;
      service: string;
      jobId: string;
      branch: string;
      repoPath?: string;
    }
  | { kind: "execution"; executionId: number; service: string; project: string; env?: string; jobId?: string; repoPath?: string };

export interface RundeckView {
  /** Pane-scoped navigation stack so back/forward feels right. */
  stack: RundeckLevel[];
}

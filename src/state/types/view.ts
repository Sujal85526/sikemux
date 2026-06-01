export interface EditorPaneView {
    openTabs: string[];
    activePath: string | null;
    treeWidth: number;
}

export type GitPanel = "status" | "files" | "branches" | "remotes" | "commits" | "stashes";

export interface GitPaneView {
    panel: GitPanel;
    selected: Record<GitPanel, number>;
    remoteDrill: string | null;
    remoteBranchSelected: Record<string, number>;
}

export const DEFAULT_GIT_VIEW: GitPaneView = {
    panel: "files",
    selected: { status: 0, files: 0, branches: 0, remotes: 0, commits: 0, stashes: 0 },
    remoteDrill: null,
    remoteBranchSelected: {},
};

export interface GlobalSearchView {
    query: string;
    replace: string;
    replaceOpen: boolean;
    options: {
        caseSensitive: boolean;
        wholeWord: boolean;
        isRegex: boolean;
        include: string;
        exclude: string;
    };
    collapsed: Record<string, boolean>;
    selected: { path: string; matchIndex: number } | null;
}

export const DEFAULT_GLOBAL_SEARCH_VIEW: GlobalSearchView = {
    query: "",
    replace: "",
    replaceOpen: false,
    options: {
        caseSensitive: false,
        wholeWord: false,
        isRegex: false,
        include: "",
        exclude: "",
    },
    collapsed: {},
    selected: null,
};

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
    stack: RundeckLevel[];
}

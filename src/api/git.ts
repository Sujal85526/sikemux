import { invoke } from "@tauri-apps/api/core";

export interface GitFile {
  path: string;
  index: string; // staged status char
  worktree: string; // working-tree status char
}

export interface GitStatus {
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitFile[];
}

export interface GitBranch {
  name: string;
  current: boolean;
  upstream: string | null;
}

export interface GitCommit {
  hash: string;
  author: string;
  date: string;
  subject: string;
}

export const git = {
  status: (repo: string) => invoke<GitStatus>("git_status", { repo }),
  diff: (repo: string, path: string, staged: boolean) =>
    invoke<string>("git_diff", { repo, path, staged }),
  stage: (repo: string, path: string) => invoke<void>("git_stage", { repo, path }),
  unstage: (repo: string, path: string) =>
    invoke<void>("git_unstage", { repo, path }),
  stageAll: (repo: string) => invoke<void>("git_stage_all", { repo }),
  branches: (repo: string) => invoke<GitBranch[]>("git_branches", { repo }),
  checkout: (repo: string, branch: string) =>
    invoke<void>("git_checkout", { repo, branch }),
  log: (repo: string) => invoke<GitCommit[]>("git_log", { repo }),
  show: (repo: string, rev: string) => invoke<string>("git_show", { repo, rev }),
  fileAt: (repo: string, rev: string, path: string) =>
    invoke<string>("git_file_at", { repo, rev, path }),
  commitFiles: (repo: string, rev: string) =>
    invoke<string[]>("git_commit_files", { repo, rev }),
  commit: (repo: string, message: string) =>
    invoke<string>("git_commit", { repo, message }),
  push: (repo: string) => invoke<string>("git_push", { repo }),
  pull: (repo: string) => invoke<string>("git_pull", { repo }),
  aiCommit: (repo: string) => invoke<string>("git_ai_commit", { repo }),
  prOpen: (repo: string) => invoke<string>("pr_open", { repo }),
};

// A file is staged when its index status is a real change (not clean/untracked).
export const isStaged = (f: GitFile) => f.index !== " " && f.index !== "?";
// A file has working-tree changes still to stage.
export const hasUnstaged = (f: GitFile) => f.worktree !== " ";

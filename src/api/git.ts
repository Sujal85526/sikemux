import { invoke } from "@tauri-apps/api/core";

export interface GitFile {
  path: string;
  index: string;
  worktree: string;
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

export interface GitOverview {
  status: GitStatus;
  branches: GitBranch[];
  log: GitCommit[];
}

export interface GitStash {
  index: number;
  refname: string;
  branch: string;
  message: string;
}

export type DiscardMode = "unstaged" | "staged" | "all";
export type StashMode = "all" | "staged" | "unstaged";

export interface GitRemote {
  name: string;
  url: string;
}

export interface GitRemoteBranch {
  name: string;
  full_ref: string;
  is_head_pointer: boolean;
  tracked_by: string | null;
  subject: string | null;
}

// Frontend cache for `git_file_at` keyed on immutable revs (sha-shaped). The
// backend already caches; this saves the IPC round-trip altogether for repeat
// reads of the same baseline (e.g. mounting many diff editors).
const fileAtCache = new Map<string, string>();
const FILE_AT_LIMIT = 200;
const SHA_RE = /^[0-9a-f]{7,}([~^][0-9]*)*$/i;

function cacheKey(repo: string, rev: string, path: string) {
  return `${repo}\0${rev}\0${path}`;
}

export const git = {
  status: (repo: string) => invoke<GitStatus>("git_status", { repo }),
  overview: (repo: string) => invoke<GitOverview>("git_overview", { repo }),
  diff: (repo: string, path: string, staged: boolean) =>
    invoke<string>("git_diff", { repo, path, staged }),
  stage: (repo: string, path: string) => invoke<void>("git_stage", { repo, path }),
  unstage: (repo: string, path: string) =>
    invoke<void>("git_unstage", { repo, path }),
  stageAll: (repo: string) => invoke<void>("git_stage_all", { repo }),
  unstageAll: (repo: string) => invoke<void>("git_unstage_all", { repo }),
  branches: (repo: string) => invoke<GitBranch[]>("git_branches", { repo }),
  checkout: (repo: string, branch: string) =>
    invoke<void>("git_checkout", { repo, branch }),
  branchCreate: (repo: string, name: string, startPoint?: string) =>
    invoke<void>("git_branch_create", {
      repo,
      name,
      startPoint: startPoint ?? null,
    }),
  merge: (repo: string, branch: string) =>
    invoke<string>("git_merge", { repo, branch }),
  log: (repo: string) => invoke<GitCommit[]>("git_log", { repo }),
  show: (repo: string, rev: string) => invoke<string>("git_show", { repo, rev }),
  fileAt: async (repo: string, rev: string, path: string): Promise<string> => {
    const cacheable = SHA_RE.test(rev);
    const key = cacheKey(repo, rev, path);
    if (cacheable) {
      const hit = fileAtCache.get(key);
      if (hit !== undefined) return hit;
    }
    const content = await invoke<string>("git_file_at", { repo, rev, path });
    if (cacheable) {
      if (fileAtCache.size > FILE_AT_LIMIT) fileAtCache.clear();
      fileAtCache.set(key, content);
    }
    return content;
  },
  commitFiles: (repo: string, rev: string) =>
    invoke<string[]>("git_commit_files", { repo, rev }),
  commit: (repo: string, message: string) =>
    invoke<string>("git_commit", { repo, message }),
  push: (repo: string) => invoke<string>("git_push", { repo }),
  pull: (repo: string) => invoke<string>("git_pull", { repo }),
  aiCommit: (repo: string) => invoke<string>("git_ai_commit", { repo }),
  prOpen: (repo: string) => invoke<string>("pr_open", { repo }),
  watchStart: (repo: string) => invoke<void>("repo_watch_start", { repo }),
  watchStop: (repo: string) => invoke<void>("repo_watch_stop", { repo }),

  // ---- discard ----
  discardFile: (repo: string, path: string, mode: DiscardMode) =>
    invoke<void>("git_discard_file", { repo, path, mode }),

  // ---- stash ----
  stashList: (repo: string) => invoke<GitStash[]>("git_stash_list", { repo }),
  stashPush: (
    repo: string,
    mode: StashMode,
    message?: string | null,
  ) =>
    invoke<void>("git_stash_push", {
      repo,
      mode,
      message: message ?? null,
    }),
  stashApply: (repo: string, index: number) =>
    invoke<void>("git_stash_apply", { repo, index }),
  stashPop: (repo: string, index: number) =>
    invoke<void>("git_stash_pop", { repo, index }),
  stashDrop: (repo: string, index: number) =>
    invoke<void>("git_stash_drop", { repo, index }),
  stashBranch: (repo: string, index: number, name: string) =>
    invoke<void>("git_stash_branch", { repo, index, name }),
  stashRename: (repo: string, index: number, newMessage: string) =>
    invoke<void>("git_stash_rename", { repo, index, newMessage }),

  // ---- remotes ----
  remotes: (repo: string) => invoke<GitRemote[]>("git_remotes", { repo }),
  remoteAdd: (repo: string, name: string, url: string) =>
    invoke<void>("git_remote_add", { repo, name, url }),
  remoteRemove: (repo: string, name: string) =>
    invoke<void>("git_remote_remove", { repo, name }),
  remoteRename: (repo: string, oldName: string, newName: string) =>
    invoke<void>("git_remote_rename", { repo, oldName, newName }),
  remoteSetUrl: (repo: string, name: string, url: string) =>
    invoke<void>("git_remote_set_url", { repo, name, url }),
  fetch: (repo: string, remote?: string | null) =>
    invoke<string>("git_fetch", { repo, remote: remote ?? null }),

  // ---- remote branches ----
  remoteBranches: (repo: string, remote: string) =>
    invoke<GitRemoteBranch[]>("git_remote_branches", { repo, remote }),
  checkoutRemoteBranch: (
    repo: string,
    remote: string,
    branch: string,
    localName?: string | null,
  ) =>
    invoke<void>("git_checkout_remote_branch", {
      repo,
      remote,
      branch,
      localName: localName ?? null,
    }),
  deleteRemoteBranch: (repo: string, remote: string, branch: string) =>
    invoke<void>("git_delete_remote_branch", { repo, remote, branch }),
  setUpstream: (repo: string, branch: string, upstream: string | null) =>
    invoke<void>("git_set_upstream", { repo, branch, upstream }),
};

export const isStaged = (f: GitFile) => f.index !== " " && f.index !== "?";
export const hasUnstaged = (f: GitFile) => f.worktree !== " ";

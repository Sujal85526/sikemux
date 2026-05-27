import { invoke, Channel } from "@tauri-apps/api/core";

export interface SearchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  isRegex: boolean;
  include: string;
  exclude: string;
}

export interface SearchRange {
  start: number;
  end: number;
}

export interface SearchHit {
  line: number; // 1-based
  text: string;
  /** Match-line text was clipped to fit the IPC payload cap. */
  truncated_text?: boolean;
  ranges: SearchRange[];
}

export interface SearchFile {
  path: string; // repo-relative
  matches: SearchHit[];
}

export interface SearchResults {
  files: SearchFile[];
  file_count: number;
  match_count: number;
  truncated: boolean;
  /** True when the search was cancelled mid-walk by a newer one. */
  cancelled?: boolean;
  elapsed_ms: number;
}

export const DEFAULT_OPTIONS: SearchOptions = {
  caseSensitive: false,
  wholeWord: false,
  isRegex: false,
  include: "",
  exclude: "",
};

export interface ReplaceFile {
  path: string;
  match_count: number;
}

export interface ReplaceError {
  path: string;
  reason: string;
}

export interface ReplaceResults {
  files: ReplaceFile[];
  file_count: number;
  match_count: number;
  errors: ReplaceError[];
  dry_run: boolean;
  elapsed_ms: number;
}

export interface FileWindow {
  doc: string;
  /** 1-based line number of the first line in `doc`. */
  start_line: number;
  total_lines: number;
  clipped_head: boolean;
  clipped_tail: boolean;
}

export const searchApi = {
  /**
   * Run a project search. Matched files stream back via `onFile` as they
   * appear (so the UI can paint before the walk completes). The promise
   * resolves with the final summary plus the full file list. Subsequent
   * calls implicitly cancel any in-flight search on the Rust side via the
   * generation counter — old `onFile` chunks may still arrive briefly, so
   * tag callers with their own request id and ignore stale callbacks.
   */
  project: (
    repo: string,
    query: string,
    options: SearchOptions,
    onFile: (file: SearchFile) => void,
  ): Promise<SearchResults> => {
    const channel = new Channel<SearchFile>();
    channel.onmessage = onFile;
    return invoke<SearchResults>("project_search", {
      repo,
      query,
      options,
      onFile: channel,
    });
  },
  replace: (
    repo: string,
    query: string,
    replace: string,
    options: SearchOptions,
    dryRun: boolean,
  ): Promise<ReplaceResults> =>
    invoke<ReplaceResults>("project_search_replace", {
      repo,
      query,
      replace,
      options,
      dryRun,
    }),
  /** Read a `before` + `after` line window around `line` for fast preview. */
  readFileWindow: (
    path: string,
    line: number,
    before: number,
    after: number,
  ): Promise<FileWindow> =>
    invoke<FileWindow>("read_file_window", { path, line, before, after }),
};

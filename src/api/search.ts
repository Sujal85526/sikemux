import { invoke } from "@tauri-apps/api/core";

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
  elapsed_ms: number;
}

export const searchApi = {
  project: (
    repo: string,
    query: string,
    options: SearchOptions,
  ): Promise<SearchResults> =>
    invoke<SearchResults>("project_search", { repo, query, options }),
  replace: (
    repo: string,
    query: string,
    replace: string,
    options: SearchOptions,
  ): Promise<ReplaceResults> =>
    invoke<ReplaceResults>("project_search_replace", {
      repo,
      query,
      replace,
      options,
    }),
};

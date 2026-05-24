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

export const searchApi = {
  project: (
    repo: string,
    query: string,
    options: SearchOptions,
  ): Promise<SearchResults> =>
    invoke<SearchResults>("project_search", { repo, query, options }),
};

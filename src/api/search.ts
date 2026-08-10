import { Channel } from "@tauri-apps/api/core";
import { invokeCommand as invoke } from "./invoke";

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
    cancelled?: boolean;
    elapsed_ms: number;
}

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
    start_line: number;
    total_lines: number;
    clipped_head: boolean;
    clipped_tail: boolean;
}

export const searchApi = {
    project: (repo: string, query: string, options: SearchOptions, onFile: (file: SearchFile) => void): Promise<SearchResults> => {
        const channel = new Channel<SearchFile>();
        channel.onmessage = onFile;
        return invoke<SearchResults>("project_search", {
            repo,
            query,
            options,
            onFile: channel,
        });
    },
    cancel: (repo: string): Promise<void> => invoke("project_search_cancel", { repo }),
    replace: (repo: string, query: string, replace: string, options: SearchOptions, dryRun: boolean): Promise<ReplaceResults> =>
        invoke<ReplaceResults>("project_search_replace", {
            repo,
            query,
            replace,
            options,
            dryRun,
        }),
    readFileWindow: (path: string, line: number, before: number, after: number): Promise<FileWindow> =>
        invoke<FileWindow>("read_file_window", { path, line, before, after }),
};

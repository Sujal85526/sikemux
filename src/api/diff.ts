import { invokeCommand as invoke } from "./invoke";

export interface DiffHunk {
    kind: "add" | "mod" | "del";
    start: number; // 0-based line in `current`
    end: number; // exclusive; equal to start for "del"
}

export const diffApi = {
    hunks: (baseline: string, current: string) => invoke<DiffHunk[]>("diff_hunks", { baseline, current }),
};

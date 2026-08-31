import type { GitFile } from "../../api/git";

export type RightView =
    { mode: "merge"; files: GitFile[] } | { mode: "commit"; rev: string; title: string; subtitle: string } | { mode: "output"; text: string };

export type GitAiProvider = "hermes" | "codex" | "claude";

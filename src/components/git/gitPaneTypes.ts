import type { GitFile } from "../../api/git";

export type RightView =
    { mode: "merge"; file: GitFile } | { mode: "commit"; rev: string; title: string; subtitle: string } | { mode: "output"; text: string };

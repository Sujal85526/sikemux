import { useEffect } from "react";
import type { EditorView } from "@codemirror/view";
import { git } from "../api/git";
import { setGitBaseline } from "../editor/gitGutter";
import { subscribe } from "../state/bus";
import { swallow } from "../state/toast";

// Pushes the HEAD content of the active file into the editor's diff baseline.
// Refreshes on:
//   * active file change (always re-fetch for the new path)
//   * `git-refresh` bus event for this repo — emitted by `runGitCmd` after a
//     local git operation that may have moved HEAD (commit, checkout, reset,
//     merge, stash apply, pull, etc.)
//
// What it intentionally does NOT do: refetch on every `fs-changed` event.
// fs-changed fires on every save (agents pumping code into the repo can
// fire it many times per second), but HEAD content doesn't change on a
// save — only on a git operation. The previous implementation was paying
// one `git_file_at` IPC per save per visible editor; this version pays
// one per actual HEAD movement. External terminal git ops won't refresh
// the baseline until the user reopens the file; that's the trade-off.
//
// `viewGetter` is *intentionally not in the effect deps*: it's `() =>
// viewRef.current` and gets a fresh closure every render. Including it
// would re-fire the effect every render, cancel the in-flight HEAD fetch,
// and (if renders out-pace IPC) leave the gutter blank.
export function useGitBaseline(viewGetter: () => EditorView | null, cwd: string, activePath: string | null) {
    useEffect(() => {
        if (!activePath || !cwd || !activePath.startsWith(`${cwd}/`)) return;
        const rel = activePath.slice(cwd.length + 1);

        const refetch = () => {
            const view = viewGetter();
            if (!view) return;
            git.fileAt(cwd, "HEAD", rel)
                .then((content) => {
                    if (viewGetter() !== view) return;
                    setGitBaseline(view, content);
                })
                .catch(swallow("git baseline"));
        };

        refetch();
        const unsub = subscribe("git-refresh", (e) => {
            if (e.repo !== cwd) return;
            refetch();
        });
        return unsub;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activePath, cwd]);
}

import { useEffect } from "react";
import type { EditorView } from "@codemirror/view";
import { git } from "../api/git";
import { setGitBaseline } from "../editor/gitGutter";
import { useWorkspace } from "../state/workspace";

// Pushes the HEAD content of the active file into the editor's diff baseline.
// Re-runs on file changes and on git refresh nonces.
//
// `viewGetter` is *intentionally not in the effect deps*: it's `() =>
// viewRef.current` from the caller and gets a fresh closure every render.
// Including it would re-fire the effect on every parent re-render (typing,
// tab list changes, …), cancel the in-flight HEAD fetch via the cleanup
// flag, and — if renders out-pace the IPC round trip — the baseline would
// never actually land, leaving the gutter blank. The ref itself is stable,
// so reading through it on demand is safe.
export function useGitBaseline(
  viewGetter: () => EditorView | null,
  cwd: string,
  activePath: string | null,
) {
  const gitRefreshN = useWorkspace((s) => s.gitRefreshN);
  useEffect(() => {
    const view = viewGetter();
    if (!view || !activePath || !cwd || !activePath.startsWith(`${cwd}/`)) {
      return;
    }
    const rel = activePath.slice(cwd.length + 1);
    let cancelled = false;
    git
      .fileAt(cwd, "HEAD", rel)
      .then((content) => {
        if (cancelled || viewGetter() !== view) return;
        setGitBaseline(view, content);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath, cwd, gitRefreshN]);
}

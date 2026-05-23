import { useEffect } from "react";
import type { EditorView } from "@codemirror/view";
import { git } from "../api/git";
import { setGitBaseline } from "../editor/gitGutter";
import { useWorkspace } from "../state/workspace";

// Pushes the HEAD content of the active file into the editor's diff baseline.
// Re-runs on file changes and on git refresh nonces.
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
  }, [viewGetter, activePath, cwd, gitRefreshN]);
}

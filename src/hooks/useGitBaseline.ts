import { useEffect, useRef } from "react";
import type { EditorView } from "@codemirror/view";
import { git } from "../api/git";
import { setGitBaseline } from "../editor/gitGutter";
import { subscribe } from "../state/bus";
import { swallow } from "../state/toast";

// Pushes the HEAD content of the active file into the editor's diff baseline.
// Refreshes when the file changes and when the bus reports an fs change in
// this repo (which the App-level listener emits on every git_changed event
// from the backend).
//
// `viewGetter` is *intentionally not in the effect deps*: it's `() =>
// viewRef.current` and gets a fresh closure every render. Including it
// would re-fire the effect every render, cancel the in-flight HEAD fetch,
// and (if renders out-pace IPC) leave the gutter blank.
export function useGitBaseline(
  viewGetter: () => EditorView | null,
  cwd: string,
  activePath: string | null,
) {
  // Bump-counter triggers a re-fetch when the bus reports an fs change for
  // this repo. Avoids hauling the entire git resource into the editor.
  const tickRef = useRef(0);

  useEffect(() => {
    return subscribe("fs-changed", (e) => {
      if (!cwd || (e.repo && e.repo !== cwd)) return;
      tickRef.current += 1;
      // Re-trigger the effect below by toggling a state — but a state hook
      // here would cause render churn for every fs event. Instead we
      // dispatch a same-args fetch directly.
      const view = viewGetter();
      if (!view || !activePath || !activePath.startsWith(`${cwd}/`)) return;
      const rel = activePath.slice(cwd.length + 1);
      git
        .fileAt(cwd, "HEAD", rel)
        .then((content) => {
          if (viewGetter() !== view) return;
          setGitBaseline(view, content);
        })
        .catch(swallow("git baseline"));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, activePath]);

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
      .catch(swallow("git baseline initial"));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath, cwd]);
}

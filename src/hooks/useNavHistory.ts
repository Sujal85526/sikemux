import { useCallback, useRef } from "react";
import type { EditorView } from "@codemirror/view";

export interface NavEntry {
  path: string;
  line: number;
  character: number;
}

interface NavOptions {
  /** Resolve the editor view that currently owns the caret. */
  getView: () => EditorView | null;
  /** Path of the currently-open document, if any. */
  getCurrentPath: () => string | null;
  /** Scroll the live editor to the entry (same file). */
  scrollLiveTo: (line: number, character: number) => void;
  /** Open another file at line/char (cross-file landings). */
  openOther: (entry: NavEntry) => void;
}

// Cmd-click pushes (origin, target); Cmd-[/Cmd-] walk the stack.
export function useNavHistory(opts: NavOptions) {
  const historyRef = useRef<NavEntry[]>([]);
  const idxRef = useRef(-1);

  const captureCurrentPos = useCallback((): NavEntry | null => {
    const view = opts.getView();
    const path = opts.getCurrentPath();
    if (!view || !path) return null;
    const head = view.state.selection.main.head;
    const line = view.state.doc.lineAt(head);
    return { path, line: line.number - 1, character: head - line.from };
  }, [opts]);

  const navigateTo = useCallback(
    (entry: NavEntry) => {
      if (entry.path === opts.getCurrentPath() && opts.getView()) {
        opts.scrollLiveTo(entry.line, entry.character);
      } else {
        opts.openOther(entry);
      }
    },
    [opts],
  );

  const push = useCallback((target: NavEntry) => {
    const origin = captureCurrentPos();
    if (origin && historyRef.current.length === 0) {
      historyRef.current = [origin];
      idxRef.current = 0;
    }
    const next = historyRef.current.slice(0, idxRef.current + 1).concat(target);
    historyRef.current = next;
    idxRef.current = next.length - 1;
    navigateTo(target);
  }, [captureCurrentPos, navigateTo]);

  const back = useCallback(() => {
    if (idxRef.current <= 0) return;
    idxRef.current -= 1;
    navigateTo(historyRef.current[idxRef.current]);
  }, [navigateTo]);

  const forward = useCallback(() => {
    if (idxRef.current >= historyRef.current.length - 1) return;
    idxRef.current += 1;
    navigateTo(historyRef.current[idxRef.current]);
  }, [navigateTo]);

  return { push, back, forward };
}

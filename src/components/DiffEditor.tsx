import { useEffect, useRef } from "react";
import { unifiedMergeView } from "@codemirror/merge";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { git } from "../api/git";
import { fsapi } from "../api/fs";
import { auraExtensions, languageFor } from "../editor/codemirror";

// A headerless CodeMirror unified-merge view of one file. `autoHeight` makes
// it grow to its content (for stacking in an accordion) rather than fill.
export function DiffEditor({
  repo,
  path,
  baseRev,
  headRev,
  editable,
  autoHeight,
  onSaved,
}: {
  repo: string;
  path: string;
  baseRev: string;
  headRev?: string; // undefined => read the working file from disk
  editable: boolean;
  autoHeight?: boolean;
  onSaved?: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    let view: EditorView | null = null;
    const absPath = `${repo}/${path}`;

    const save = (v: EditorView): boolean => {
      void fsapi
        .writeFile(absPath, v.state.doc.toString())
        .then(() => onSaved?.())
        .catch(() => {});
      return true;
    };

    void (async () => {
      const [base, head] = await Promise.all([
        git.fileAt(repo, baseRev, path).catch(() => ""),
        headRev
          ? git.fileAt(repo, headRev, path).catch(() => "")
          : fsapi.readFile(absPath).catch(() => ""),
      ]);
      if (cancelled || !hostRef.current) return;

      const exts: Extension[] = [
        basicSetup,
        auraExtensions,
        ...languageFor(path),
        unifiedMergeView({
          original: base,
          mergeControls: editable,
          collapseUnchanged: { margin: 3, minSize: 4 },
        }),
      ];
      if (autoHeight) {
        exts.push(
          EditorView.theme({
            "&": { height: "auto" },
            ".cm-scroller": { overflow: "visible" },
          }),
        );
      }
      if (editable) {
        exts.push(keymap.of([{ key: "Mod-s", preventDefault: true, run: save }]));
      } else {
        exts.push(EditorState.readOnly.of(true), EditorView.editable.of(false));
      }

      view = new EditorView({
        parent: hostRef.current,
        state: EditorState.create({ doc: head, extensions: exts }),
      });
    })();

    return () => {
      cancelled = true;
      view?.destroy();
    };
  }, [repo, path, baseRev, headRev, editable, autoHeight, onSaved]);

  return <div className={`diff-editor${autoHeight ? " auto" : ""}`} ref={hostRef} />;
}

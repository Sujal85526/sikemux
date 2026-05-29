import { useEffect, useRef, useState } from "react";
import { unifiedMergeView } from "@codemirror/merge";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { git } from "../api/git";
import { fsapi } from "../api/fs";
import { auraExtensions, languageFor } from "../editor/codemirror";
import { registerView } from "../themes/bus";
import { errMessage, swallow } from "../state/toast";

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
    const [error, setError] = useState<string | null>(null);
    // Live ref to the latest onSaved so the mount-effect dep list stays
    // stable. Without this, parents that pass a fresh inline arrow ({
    // onSaved={() => …} }) cause the entire CodeMirror EditorView to
    // destroy + rebuild on every parent render, which manifests as visible
    // flicker the moment the user clicks into the diff (GitPane re-renders
    // when overview polling or the fs-watch fire, ~5 Hz at idle).
    const onSavedRef = useRef(onSaved);
    onSavedRef.current = onSaved;

    useEffect(() => {
        let cancelled = false;
        let view: EditorView | null = null;
        let unregister: (() => void) | null = null;
        const absPath = `${repo}/${path}`;
        setError(null);

        const save = (v: EditorView): boolean => {
            void fsapi
                .writeFile(absPath, v.state.doc.toString())
                .then(() => onSavedRef.current?.())
                .catch(swallow("DiffEditor save"));
            return true;
        };

        void (async () => {
            let base = "";
            let head = "";
            try {
                [base, head] = await Promise.all([
                    git.fileAt(repo, baseRev, path),
                    headRev ? git.fileAt(repo, headRev, path) : readWorkingFile(absPath),
                ]);
            } catch (err) {
                if (!cancelled) setError(errMessage(err));
                return;
            }
            if (cancelled || !hostRef.current) return;

            // Syntax highlighting parses the whole document — skip it for huge
            // files where it's unreadable anyway and costs noticeable time.
            const HIGHLIGHT_LIMIT = 2000;
            const lines = Math.max(countLines(base), countLines(head));
            const exts: Extension[] = [
                basicSetup,
                auraExtensions,
                ...(lines > HIGHLIGHT_LIMIT ? [] : languageFor(path)),
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
            unregister = registerView(view);
        })();

        return () => {
            cancelled = true;
            unregister?.();
            view?.destroy();
        };
        // Intentionally excludes onSaved — it's read via onSavedRef. Mounting
        // only depends on what actually defines the editor (file + base/head
        // + editability), so cursor / scroll never trigger a remount.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [repo, path, baseRev, headRev, editable, autoHeight]);

    return (
        <div className={`diff-editor${autoHeight ? " auto" : ""}`} ref={hostRef}>
            {error && <div className="diff-editor-error">x {error}</div>}
        </div>
    );
}

function countLines(s: string): number {
    let n = 1;
    for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
    return n;
}

async function readWorkingFile(path: string): Promise<string> {
    try {
        return await fsapi.readFile(path);
    } catch (err) {
        if (isMissingFileError(err)) return "";
        throw err;
    }
}

function isMissingFileError(err: unknown): boolean {
    const msg = errMessage(err).toLowerCase();
    return msg.includes("no such file") || msg.includes("not found") || msg.includes("os error 2");
}

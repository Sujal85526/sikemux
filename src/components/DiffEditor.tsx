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
import { joinPath } from "../lib/paths";

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
    const onSavedRef = useRef(onSaved);
    onSavedRef.current = onSaved;

    useEffect(() => {
        let cancelled = false;
        let view: EditorView | null = null;
        let unregister: (() => void) | null = null;
        const absPath = joinPath(repo, path);
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
            const guard = inlineDiffGuard(path, base, head);
            if (guard) {
                setError(guard);
                return;
            }

            const HIGHLIGHT_LIMIT = 2000;
            const lines = Math.max(countLines(base), countLines(head));
            const exts: Extension[] = [
                basicSetup,
                auraExtensions,
                ...(lines > HIGHLIGHT_LIMIT ? [] : languageFor(path)),
                unifiedMergeView({
                    original: base,
                    // No per-chunk accept/reject: this is a review surface, and
                    // staging/discarding belongs to the Files panel verbs.
                    mergeControls: false,
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
    }, [repo, path, baseRev, headRev, editable, autoHeight]);

    return (
        <div className={`diff-editor${autoHeight ? " auto" : ""}`} ref={hostRef}>
            {error && <div className="diff-editor-error">x {error}</div>}
        </div>
    );
}

const MAX_INLINE_DIFF_CHARS = 1024 * 1024;

function inlineDiffGuard(path: string, base: string, head: string): string | null {
    const largest = Math.max(base.length, head.length);
    if (largest > MAX_INLINE_DIFF_CHARS) return `${path} is too large for inline diff (${humanChars(largest)}).`;
    if (looksBinaryText(base) || looksBinaryText(head)) return `${path} looks binary; inline diff is disabled.`;
    return null;
}

function looksBinaryText(s: string): boolean {
    const sample = s.slice(0, 8192);
    if (sample.includes("\0")) return true;
    // Backend used to decode blobs with from_utf8_lossy; a binary blob then
    // arrives full of replacement chars and can wedge CodeMirror's merge view.
    let replacements = 0;
    for (let i = 0; i < sample.length; i++) if (sample.charCodeAt(i) === 0xfffd) replacements++;
    return replacements > 8;
}

function humanChars(n: number): string {
    return n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${(n / 1024).toFixed(1)} KB`;
}

function countLines(s: string): number {
    let n = 1;
    for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
    return n;
}

async function readWorkingFile(path: string): Promise<string> {
    try {
        return await fsapi.readTextFileLimited(path);
    } catch (err) {
        if (isMissingFileError(err)) return "";
        throw err;
    }
}

function isMissingFileError(err: unknown): boolean {
    const msg = errMessage(err).toLowerCase();
    return msg.includes("no such file") || msg.includes("not found") || msg.includes("os error 2");
}

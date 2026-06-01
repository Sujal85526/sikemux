import { type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { languageFromPath, lsp, uriToPath } from "../api/lsp";
import { openLspPeek } from "./lspPeek";
import { swallow } from "../state/toast";

export interface LspContext {
    project: string;
    path: string;
    navigate: (path: string, line: number, character: number) => void;
}

const contexts = new WeakMap<EditorView, LspContext>();

export function setLspContext(view: EditorView | null, ctx: LspContext | null) {
    if (!view) return;
    if (ctx) contexts.set(view, ctx);
    else contexts.delete(view);
}

export function lspNav(): Extension {
    return EditorView.domEventHandlers({
        mousedown(event, view) {
            if (!(event.metaKey || event.ctrlKey)) return false;
            if (event.button !== 0) return false;
            const ctx = contexts.get(view);
            if (!ctx) return false;
            const lang = languageFromPath(ctx.path);
            if (!lang) return false;
            const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
            if (pos == null) return false;
            const line = view.state.doc.lineAt(pos);
            const character = pos - line.from;
            event.preventDefault();

            const kind: "references" | "implementation" | "definition" = event.shiftKey
                ? "references"
                : event.altKey
                  ? "implementation"
                  : "definition";
            const title = kind === "references" ? "References" : kind === "implementation" ? "Implementations" : "Definitions";
            const fn = kind === "references" ? lsp.references : kind === "implementation" ? lsp.implementation : lsp.definition;

            void fn(ctx.project, lang, ctx.path, line.number - 1, character)
                .then((locs) => {
                    if (locs.length === 0) return;
                    if (kind !== "references" && locs.length === 1) {
                        const t = locs[0];
                        ctx.navigate(uriToPath(t.uri), t.range.start.line, t.range.start.character);
                        return;
                    }
                    openLspPeek(view, {
                        atLine: line.number - 1,
                        title,
                        items: locs.map((l) => ({
                            uri: l.uri,
                            line: l.range.start.line,
                            character: l.range.start.character,
                        })),
                    });
                })
                .catch(swallow("lsp definition"));
            return true;
        },
    });
}

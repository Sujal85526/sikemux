import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin } from "@codemirror/view";
import { languageFromPath, lsp } from "../api/lsp";
import { swallow } from "../state/toast";

type Range = { from: number; to: number } | null;

const setLink = StateEffect.define<Range>();

const linkField = StateField.define<Range>({
    create: () => null,
    update(v, tr) {
        for (const e of tr.effects) if (e.is(setLink)) v = e.value;
        return v;
    },
    provide: (f) =>
        EditorView.decorations.compute([f], (state) => {
            const r = state.field(f);
            if (!r) return Decoration.none;
            return Decoration.set([Decoration.mark({ class: "cm-lsp-link" }).range(r.from, r.to)]);
        }),
});

const contexts = new WeakMap<EditorView, { project: string; path: string }>();

export function setHoverLinkContext(view: EditorView | null, c: { project: string; path: string } | null) {
    if (!view) return;
    if (c) contexts.set(view, c);
    else contexts.delete(view);
}

let debounceTimer: number | undefined;
let lastView: EditorView | null = null;
let lastRangeKey = "";
// Cheap guard so the common mousemove path (no modifier held — e.g. drag-select
// or plain scrolling) does no EditorState field reads or dispatches.
let linkShown = false;

function clear(view: EditorView) {
    if (linkShown && view.state.field(linkField, false)) {
        view.dispatch({ effects: setLink.of(null) });
    }
    linkShown = false;
    lastRangeKey = "";
}

const hoverHandlers = EditorView.domEventHandlers({
    mousemove(event, view) {
        lastView = view;
        if (!(event.metaKey || event.ctrlKey)) {
            clear(view);
            return false;
        }
        const ctx = contexts.get(view);
        if (!ctx) return false;
        const lang = languageFromPath(ctx.path);
        if (!lang) return false;
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos == null) {
            clear(view);
            return false;
        }
        const word = view.state.wordAt(pos);
        if (!word) {
            clear(view);
            return false;
        }
        const key = `${word.from}:${word.to}`;
        if (key === lastRangeKey) return false;
        lastRangeKey = key;
        if (debounceTimer) window.clearTimeout(debounceTimer);
        const line = view.state.doc.lineAt(word.from);
        const character = word.from - line.from;
        const lineNo = line.number - 1;
        debounceTimer = window.setTimeout(() => {
            const latest = contexts.get(view);
            if (!latest || latest.project !== ctx.project || latest.path !== ctx.path) return;
            void lsp
                .definition(ctx.project, lang, ctx.path, lineNo, character)
                .then((locs) => {
                    if (locs.length === 0 || lastRangeKey !== key) return;
                    view.dispatch({ effects: setLink.of({ from: word.from, to: word.to }) });
                    linkShown = true;
                })
                .catch(swallow("lsp hover"));
        }, 120);
        return false;
    },
    mouseleave(_event, view) {
        clear(view);
        return false;
    },
});

const keyReleasePlugin = ViewPlugin.fromClass(
    class {
        constructor(public view: EditorView) {
            document.addEventListener("keyup", this.onKeyUp);
            window.addEventListener("blur", this.onBlur);
        }
        destroy() {
            document.removeEventListener("keyup", this.onKeyUp);
            window.removeEventListener("blur", this.onBlur);
        }
        onKeyUp = (e: KeyboardEvent) => {
            if (e.key === "Meta" || e.key === "Control") {
                const v = lastView ?? this.view;
                clear(v);
            }
        };
        onBlur = () => clear(lastView ?? this.view);
    },
);

export function lspHoverLink(): Extension {
    return [linkField, hoverHandlers, keyReleasePlugin];
}

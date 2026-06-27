import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, WidgetType, type ViewUpdate } from "@codemirror/view";
import { git, type GitBlame } from "../api/git";
import { swallow } from "../state/toast";

const setBlame = StateEffect.define<GitBlame | null>();

const blameField = StateField.define<GitBlame | null>({
    create: () => null,
    update(value, tr) {
        for (const e of tr.effects) if (e.is(setBlame)) value = e.value;
        return value;
    },
});

// Repo + (repo-relative) path the current document maps to. Kept off the
// EditorState (like the LSP hover-link context) so swapping it doesn't churn a
// transaction; the fetch plugin reads it lazily.
const contexts = new WeakMap<EditorView, { repo: string; path: string }>();

class BlameWidget extends WidgetType {
    constructor(
        readonly text: string,
        readonly uncommitted: boolean,
    ) {
        super();
    }
    override eq(o: BlameWidget) {
        return o.text === this.text && o.uncommitted === this.uncommitted;
    }
    override toDOM() {
        const el = document.createElement("span");
        el.className = "cm-blame" + (this.uncommitted ? " cm-blame-uncommitted" : "");
        el.textContent = this.text;
        return el;
    }
    // Faint annotation only — never let it eat clicks/selection.
    override ignoreEvent() {
        return true;
    }
}

// The single inline annotation for the caret's line. Empty selection only:
// while text is selected (or mid-drag) we get out of the way.
function widgetFor(view: EditorView): DecorationSet {
    const sel = view.state.selection.main;
    if (!sel.empty) return Decoration.none;
    const blame = view.state.field(blameField, false);
    if (!blame || blame.lines.length === 0) return Decoration.none;
    const line = view.state.doc.lineAt(sel.head);
    const idx = blame.lines[line.number - 1];
    if (idx == null) return Decoration.none;
    const commit = blame.commits[idx];
    if (!commit) return Decoration.none;
    const text = commit.uncommitted ? "You · Uncommitted changes" : `${commit.author}, ${commit.time} · ${commit.summary}`;
    return Decoration.set([
        Decoration.widget({
            widget: new BlameWidget(text, commit.uncommitted),
            side: 1,
        }).range(line.to),
    ]);
}

const blameRender = ViewPlugin.fromClass(
    class {
        deco: DecorationSet;
        constructor(view: EditorView) {
            this.deco = widgetFor(view);
        }
        update(u: ViewUpdate) {
            // Mid-edit the cached blame no longer lines up with the buffer's
            // line numbers; hide until the debounced re-blame settles.
            if (u.docChanged) {
                this.deco = Decoration.none;
                return;
            }
            const blameChanged = u.startState.field(blameField, false) !== u.state.field(blameField, false);
            if (u.selectionSet || blameChanged) this.deco = widgetFor(u.view);
        }
    },
    { decorations: (v) => v.deco },
);

// Owns the (debounced) backend fetch. Cursor moves never reach here — only doc
// edits and explicit refreshes do — so the common interaction is pure lookup.
const blameFetch = ViewPlugin.fromClass(
    class {
        timer: number | undefined;
        token = 0;
        constructor(readonly view: EditorView) {}
        update(u: ViewUpdate) {
            if (u.docChanged) this.schedule(450);
        }
        schedule(delay: number) {
            if (this.timer) window.clearTimeout(this.timer);
            this.timer = window.setTimeout(() => this.run(), delay);
        }
        run() {
            const ctx = contexts.get(this.view);
            if (!ctx) return;
            const my = ++this.token;
            // Blame the live buffer so unsaved edits map to the right lines.
            const contents = this.view.state.doc.toString();
            git.blame(ctx.repo, ctx.path, contents)
                .then((data) => {
                    if (my !== this.token || contexts.get(this.view) !== ctx) return;
                    this.view.dispatch({ effects: setBlame.of(data) });
                })
                .catch(swallow("git blame"));
        }
        destroy() {
            if (this.timer) window.clearTimeout(this.timer);
        }
    },
);

export function gitInlineBlame(): Extension {
    return [blameField, blameFetch, blameRender];
}

/** Point the blame extension at a file (or clear it) and kick a fresh fetch. */
export function setBlameContext(view: EditorView | null, ctx: { repo: string; path: string } | null) {
    if (!view) return;
    if (!ctx) {
        contexts.delete(view);
        if (view.state.field(blameField, false)) view.dispatch({ effects: setBlame.of(null) });
        return;
    }
    const prev = contexts.get(view);
    if (prev && prev.repo === ctx.repo && prev.path === ctx.path) return;
    contexts.set(view, ctx);
    // No need to clear first: blame lives in the per-file EditorState, so a
    // cached tab already holds its own (correct) blame; the fetch refreshes it.
    view.plugin(blameFetch)?.schedule(0);
}

/** Re-fetch blame for the current file (e.g. after a commit / external change). */
export function refreshBlame(view: EditorView | null) {
    if (!view) return;
    view.plugin(blameFetch)?.schedule(0);
}

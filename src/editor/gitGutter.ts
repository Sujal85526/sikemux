import { presentableDiff } from "@codemirror/merge";
import {
  RangeSet,
  RangeSetBuilder,
  StateEffect,
  StateField,
  type Extension,
} from "@codemirror/state";
import {
  EditorView,
  gutter,
  GutterMarker,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";

// VSCode-style git diff gutter: green bar for added lines, blue for modified,
// red triangle at the boundary where lines were deleted. Baseline (HEAD
// content) is supplied per-file by EditorPane via `setGitBaseline`.

const setBaseline = StateEffect.define<string>();

const baselineField = StateField.define<string>({
  create: () => "",
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setBaseline)) value = e.value;
    return value;
  },
});

class GitMarker extends GutterMarker {
  constructor(readonly kind: "add" | "mod" | "del") {
    super();
  }
  override eq(other: GutterMarker) {
    return other instanceof GitMarker && other.kind === this.kind;
  }
  override toDOM() {
    const el = document.createElement("div");
    el.className = `cm-git-marker cm-git-${this.kind}`;
    return el;
  }
}

function computeMarkers(view: EditorView): RangeSet<GitMarker> {
  const baseline = view.state.field(baselineField);
  if (!baseline) return RangeSet.empty;
  const current = view.state.doc.toString();
  if (current === baseline) return RangeSet.empty;
  const changes = presentableDiff(baseline, current);
  const builder = new RangeSetBuilder<GitMarker>();
  const doc = view.state.doc;
  for (const c of changes) {
    const isAdd = c.fromA === c.toA;
    const isDel = c.fromB === c.toB;
    if (isDel) {
      const line = doc.lineAt(Math.min(c.fromB, doc.length));
      builder.add(line.from, line.from, new GitMarker("del"));
      continue;
    }
    const fromLine = doc.lineAt(c.fromB);
    const toLine = doc.lineAt(Math.min(c.toB, doc.length));
    const kind: "add" | "mod" = isAdd ? "add" : "mod";
    for (let ln = fromLine.number; ln <= toLine.number; ln++) {
      const line = doc.line(ln);
      builder.add(line.from, line.from, new GitMarker(kind));
    }
  }
  return builder.finish();
}

const gitPlugin = ViewPlugin.fromClass(
  class {
    markers: RangeSet<GitMarker>;
    constructor(view: EditorView) {
      this.markers = computeMarkers(view);
    }
    update(u: ViewUpdate) {
      const baseChanged =
        u.startState.field(baselineField) !== u.state.field(baselineField);
      if (u.docChanged || baseChanged) {
        this.markers = computeMarkers(u.view);
      }
    }
  },
);

const gitGutterExt = gutter({
  class: "cm-git-gutter",
  markers: (view) => view.plugin(gitPlugin)?.markers ?? RangeSet.empty,
});

// Overview ruler — a vertical strip on the right edge of the editor that
// summarises *all* diff chunks in the file, so the user can see at a glance
// where the changes are and how far to scroll.
const overviewRuler = ViewPlugin.fromClass(
  class {
    dom: HTMLDivElement;
    constructor(view: EditorView) {
      this.dom = document.createElement("div");
      this.dom.className = "cm-git-ruler";
      view.dom.appendChild(this.dom);
      this.render(view);
    }
    update(u: ViewUpdate) {
      const baseChanged =
        u.startState.field(baselineField) !== u.state.field(baselineField);
      if (u.docChanged || baseChanged) this.render(u.view);
    }
    destroy() {
      this.dom.remove();
    }
    render(view: EditorView) {
      const baseline = view.state.field(baselineField);
      const doc = view.state.doc;
      this.dom.replaceChildren();
      if (!baseline || doc.toString() === baseline) return;
      const changes = presentableDiff(baseline, doc.toString());
      const totalLines = doc.lines;
      for (const c of changes) {
        const isAdd = c.fromA === c.toA;
        const isDel = c.fromB === c.toB;
        const startLine = doc.lineAt(Math.min(c.fromB, doc.length)).number;
        const endLine = isDel
          ? startLine
          : doc.lineAt(Math.min(c.toB, doc.length)).number;
        const top = ((startLine - 1) / totalLines) * 100;
        const lineSpan = Math.max(endLine - startLine + 1, 1);
        const height = isDel
          ? 0
          : Math.max((lineSpan / totalLines) * 100, 0.4);
        const bar = document.createElement("div");
        const kind = isDel ? "del" : isAdd ? "add" : "mod";
        bar.className = `cm-git-ruler-bar ${kind}`;
        bar.style.top = `${top}%`;
        bar.style.height = `${height}%`;
        this.dom.appendChild(bar);
      }
    }
  },
);

export function gitDiffGutter(): Extension {
  return [baselineField, gitPlugin, gitGutterExt, overviewRuler];
}

// Push a new baseline (e.g. the file's HEAD content) into a live view.
export function setGitBaseline(view: EditorView, baseline: string) {
  view.dispatch({ effects: setBaseline.of(baseline) });
}

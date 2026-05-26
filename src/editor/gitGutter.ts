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
import { diffApi, type DiffHunk } from "../api/diff";
import { swallow } from "../state/toast";

// VSCode-style git diff gutter: green bar for added lines, blue for modified,
// red triangle at the boundary where lines were deleted. Baseline (HEAD
// content) is supplied per-file by EditorPane via `setGitBaseline`. Hunks
// are computed in Rust via `diff_hunks` so per-keystroke diffing stays off
// the main JS thread.

const setBaseline = StateEffect.define<string>();
const setHunks = StateEffect.define<DiffHunk[]>();

const baselineField = StateField.define<string>({
  create: () => "",
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setBaseline)) value = e.value;
    return value;
  },
});

const hunksField = StateField.define<DiffHunk[]>({
  create: () => [],
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setHunks)) value = e.value;
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

function markersFromHunks(view: EditorView, hunks: DiffHunk[]): RangeSet<GitMarker> {
  if (hunks.length === 0) return RangeSet.empty;
  const doc = view.state.doc;
  const docLines = doc.lines;
  // Collect (pos, marker) tuples first and sort them before feeding the
  // builder. The hunks come in document order from Rust, but if the doc has
  // shrunk since the diff was computed (user deleted lines, etc.) we used to
  // clamp later hunks back into range — which produced positions that were
  // smaller than the previous hunk's last marker and crashed
  // RangeSetBuilder. A crash here takes down the whole gutter column
  // (line numbers + fold chevrons + git markers) because CodeMirror tears
  // the gutter view down on render errors. Skip out-of-range hunks instead
  // and sort defensively as a belt-and-braces guard.
  const tuples: Array<[number, GitMarker]> = [];
  for (const h of hunks) {
    if (h.kind === "del") {
      const lineNo = h.start + 1;
      if (lineNo < 1 || lineNo > docLines) continue;
      tuples.push([doc.line(lineNo).from, new GitMarker("del")]);
      continue;
    }
    const startLine = h.start + 1;
    if (startLine < 1 || startLine > docLines) continue;
    const endLine = Math.min(h.end, docLines);
    for (let ln = startLine; ln <= endLine; ln++) {
      tuples.push([doc.line(ln).from, new GitMarker(h.kind)]);
    }
  }
  if (tuples.length === 0) return RangeSet.empty;
  tuples.sort((a, b) => a[0] - b[0]);
  const builder = new RangeSetBuilder<GitMarker>();
  for (const [pos, marker] of tuples) builder.add(pos, pos, marker);
  return builder.finish();
}

// Debounce + cancel Rust diff calls. The text from `current` is captured at
// schedule time; a new edit cancels the prior request.
function scheduleHunks(view: EditorView): { cancel: () => void } {
  let timer: number | undefined;
  let token = 0;
  const run = () => {
    const baseline = view.state.field(baselineField);
    const current = view.state.doc.toString();
    if (!baseline) {
      view.dispatch({ effects: setHunks.of([]) });
      return;
    }
    if (current === baseline) {
      view.dispatch({ effects: setHunks.of([]) });
      return;
    }
    const my = ++token;
    diffApi
      .hunks(baseline, current)
      .then((hunks) => {
        if (my !== token) return;
        view.dispatch({ effects: setHunks.of(hunks) });
      })
      .catch(swallow("diff hunks"));
  };
  return {
    cancel: () => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(run, 120);
    },
  };
}

// Schedule-only plugin — its sole job is to debounce a Rust diff call
// whenever the doc or baseline changes. Markers themselves live in the
// hunksField (a StateField), which the gutter reads directly. Going through
// the StateField avoids a race where the plugin's mutated `this.markers`
// is read before its update() finishes for the current view update cycle.
const gitPlugin = ViewPlugin.fromClass(
  class {
    sched: { cancel: () => void };
    constructor(view: EditorView) {
      this.sched = scheduleHunks(view);
      // First run after mount so we don't wait for the first keystroke.
      this.sched.cancel();
    }
    update(u: ViewUpdate) {
      const baseChanged =
        u.startState.field(baselineField) !== u.state.field(baselineField);
      if (u.docChanged || baseChanged) this.sched.cancel();
    }
  },
);

const gitGutterExt = gutter({
  class: "cm-git-gutter",
  // Read hunks straight from the StateField on every render — guaranteed
  // to be the value that exists at this point in the update pipeline.
  markers: (view) => markersFromHunks(view, view.state.field(hunksField)),
});

// Overview ruler — a vertical strip on the right edge summarising every diff
// chunk in the file. Driven from the same hunks the gutter consumes.
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
      const hunksChanged =
        u.startState.field(hunksField) !== u.state.field(hunksField);
      if (u.docChanged || hunksChanged) this.render(u.view);
    }
    destroy() {
      this.dom.remove();
    }
    render(view: EditorView) {
      const hunks = view.state.field(hunksField);
      const doc = view.state.doc;
      this.dom.replaceChildren();
      if (hunks.length === 0) return;
      const totalLines = doc.lines;
      for (const h of hunks) {
        const startLine = Math.max(1, Math.min(h.start + 1, totalLines));
        const endLine =
          h.kind === "del"
            ? startLine
            : Math.max(startLine, Math.min(h.end, totalLines));
        const top = ((startLine - 1) / totalLines) * 100;
        const span = Math.max(endLine - startLine + 1, 1);
        const height = h.kind === "del" ? 0 : Math.max((span / totalLines) * 100, 0.4);
        const bar = document.createElement("button");
        bar.type = "button";
        bar.className = `cm-git-ruler-bar ${h.kind}`;
        bar.style.top = `${top}%`;
        bar.style.height = `${height}%`;
        bar.title =
          h.kind === "del"
            ? `Deleted before line ${startLine}`
            : h.kind === "add"
              ? `Added lines ${startLine}–${endLine}`
              : `Modified lines ${startLine}–${endLine}`;
        bar.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          const line = view.state.doc.line(startLine);
          view.dispatch({
            selection: { anchor: line.from },
            effects: EditorView.scrollIntoView(line.from, { y: "center" }),
          });
          view.focus();
        };
        this.dom.appendChild(bar);
      }
    }
  },
);

export function gitDiffGutter(): Extension {
  return [baselineField, hunksField, gitPlugin, gitGutterExt, overviewRuler];
}

// Push a new baseline (e.g. the file's HEAD content) into a live view.
export function setGitBaseline(view: EditorView, baseline: string) {
  view.dispatch({ effects: setBaseline.of(baseline) });
}

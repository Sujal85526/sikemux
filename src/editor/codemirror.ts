import {
  HighlightStyle,
  StreamLanguage,
  syntaxHighlighting,
} from "@codemirror/language";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { go } from "@codemirror/lang-go";
import { yaml } from "@codemirror/lang-yaml";
import { c, cpp, java } from "@codemirror/legacy-modes/mode/clike";
import { diff as diffMode } from "@codemirror/legacy-modes/mode/diff";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { lua } from "@codemirror/legacy-modes/mode/lua";
import { nginx } from "@codemirror/legacy-modes/mode/nginx";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { hcl, makefile } from "./langs";
import {
  EditorState,
  RangeSetBuilder,
  type Extension,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

// Picks CodeMirror language support from a file name. Filename-based languages
// (Makefile, Dockerfile) are matched first, then by extension.
export function languageFor(path: string): Extension[] {
  const file = path.split("/").pop()?.toLowerCase() ?? "";
  if (file === "makefile" || file === "gnumakefile" || file.endsWith(".mk"))
    return [StreamLanguage.define(makefile)];
  if (file === "dockerfile" || file.startsWith("dockerfile."))
    return [StreamLanguage.define(dockerFile)];

  const ext = file.includes(".") ? file.split(".").pop()! : "";
  switch (ext) {
    case "ts":
    case "mts":
    case "cts":
      return [javascript({ typescript: true })];
    case "tsx":
      return [javascript({ typescript: true, jsx: true })];
    case "js":
    case "mjs":
    case "cjs":
      return [javascript()];
    case "jsx":
      return [javascript({ jsx: true })];
    case "rs":
      return [rust()];
    case "py":
      return [python()];
    case "go":
      return [go()];
    case "json":
      return [json()];
    case "yaml":
    case "yml":
      return [yaml()];
    case "toml":
      return [StreamLanguage.define(toml)];
    case "tf":
    case "tfvars":
    case "hcl":
      return [StreamLanguage.define(hcl)];
    case "sh":
    case "bash":
    case "zsh":
      return [StreamLanguage.define(shell)];
    case "rb":
      return [StreamLanguage.define(ruby)];
    case "lua":
      return [StreamLanguage.define(lua)];
    case "c":
    case "h":
      return [StreamLanguage.define(c)];
    case "cc":
    case "cpp":
    case "cxx":
    case "hpp":
      return [StreamLanguage.define(cpp)];
    case "java":
      return [StreamLanguage.define(java)];
    case "css":
    case "scss":
    case "less":
      return [css()];
    case "html":
    case "htm":
      return [html()];
    case "md":
    case "markdown":
      return [markdown()];
    case "conf":
      return [StreamLanguage.define(nginx)];
    case "ini":
    case "env":
    case "properties":
      return [StreamLanguage.define(properties)];
    default:
      return [];
  }
}

const auraTheme = EditorView.theme(
  {
    "&": { color: "#e7e5ef", backgroundColor: "transparent" },
    ".cm-content": {
      caretColor: "#a277ff",
      fontFamily: '"JetBrainsMono Nerd Font", "JetBrains Mono", monospace',
      fontSize: "13px",
    },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#a277ff" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
      { backgroundColor: "#352f4f" },
    ".cm-activeLine": { backgroundColor: "rgba(162,119,255,0.055)" },
    ".cm-gutters": {
      backgroundColor: "transparent",
      color: "#48464f",
      border: "none",
    },
    ".cm-activeLineGutter": { backgroundColor: "transparent", color: "#a277ff" },
    ".cm-scroller": {
      fontFamily: '"JetBrainsMono Nerd Font", "JetBrains Mono", monospace',
      lineHeight: "1.6",
    },
    ".cm-selectionMatch": { backgroundColor: "rgba(162,119,255,0.18)" },
    ".cm-foldPlaceholder": {
      backgroundColor: "#242130",
      color: "#8b8898",
      border: "none",
    },
    "&.cm-editor.cm-focused": { outline: "none" },
  },
  { dark: true },
);

const auraHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword], color: "#a277ff" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "#61ffca" },
  {
    tag: [t.comment, t.lineComment, t.blockComment],
    color: "#565461",
    fontStyle: "italic",
  },
  { tag: [t.number, t.bool, t.atom, t.null], color: "#ffca85" },
  {
    tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName],
    color: "#ff6ac1",
  },
  { tag: [t.typeName, t.className, t.namespace], color: "#ffca85" },
  { tag: [t.variableName, t.definition(t.variableName)], color: "#e7e5ef" },
  { tag: [t.propertyName], color: "#82d9ff" },
  { tag: [t.tagName], color: "#ff6ac1" },
  { tag: [t.attributeName], color: "#ffca85" },
  { tag: [t.operator, t.punctuation, t.bracket, t.separator], color: "#8b8898" },
  { tag: [t.heading], color: "#a277ff", fontWeight: "bold" },
  { tag: [t.link, t.url], color: "#61ffca" },
  { tag: [t.invalid], color: "#ff6767" },
  { tag: [t.meta, t.processingInstruction], color: "#8b8898" },
]);

export const auraExtensions: Extension = [
  auraTheme,
  syntaxHighlighting(auraHighlight),
];

// ---- diff viewer ----------------------------------------------------------

const diffAdd = Decoration.line({ class: "cm-diff-add" });
const diffDel = Decoration.line({ class: "cm-diff-del" });
const diffHunk = Decoration.line({ class: "cm-diff-hunk" });
const diffMeta = Decoration.line({ class: "cm-diff-meta" });

// Tints whole lines by their diff role (added / removed / hunk / file header).
function buildDiffDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const { doc } = view.state;
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const tx = line.text;
    let deco: Decoration | null = null;
    if (tx.startsWith("@@")) deco = diffHunk;
    else if (
      tx.startsWith("+++") ||
      tx.startsWith("---") ||
      tx.startsWith("diff ") ||
      tx.startsWith("index ") ||
      tx.startsWith("new file") ||
      tx.startsWith("deleted file") ||
      tx.startsWith("similarity ") ||
      tx.startsWith("rename ")
    )
      deco = diffMeta;
    else if (tx.startsWith("+")) deco = diffAdd;
    else if (tx.startsWith("-")) deco = diffDel;
    if (deco) builder.add(line.from, line.from, deco);
  }
  return builder.finish();
}

const diffLineDecorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDiffDecorations(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged) this.decorations = buildDiffDecorations(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);

// Read-only extensions for the git diff viewer: diff syntax + line tinting.
export const diffExtensions: Extension = [
  StreamLanguage.define(diffMode),
  auraTheme,
  syntaxHighlighting(auraHighlight),
  diffLineDecorations,
  EditorView.editable.of(false),
  EditorState.readOnly.of(true),
  EditorView.theme({
    ".cm-content": { fontSize: "11.5px" },
    ".cm-scroller": { lineHeight: "1.5" },
  }),
];

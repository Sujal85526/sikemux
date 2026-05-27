import { StreamLanguage } from "@codemirror/language";
import { themeCompartmentExtension } from "../themes/bus";
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
import { EditorState, RangeSetBuilder, type Extension } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

// Picks CodeMirror language support from a file name. Filename-based languages
// (Makefile, Dockerfile) are matched first, then by extension.
export function languageFor(path: string): Extension[] {
    const file = path.split("/").pop()?.toLowerCase() ?? "";
    if (file === "makefile" || file === "gnumakefile" || file.endsWith(".mk")) return [StreamLanguage.define(makefile)];
    if (file === "dockerfile" || file.startsWith("dockerfile.")) return [StreamLanguage.define(dockerFile)];

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

// Theme-driven extensions are pulled from the theme bus so the active theme
// can be reconfigured at runtime. The bus owns the compartment and the live
// set of EditorViews.
export const auraExtensions: Extension = themeCompartmentExtension();

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
// Theme also comes from the bus so diff views restyle when the user changes
// theme just like normal editors.
export const diffExtensions: Extension = [
    StreamLanguage.define(diffMode),
    themeCompartmentExtension(),
    diffLineDecorations,
    EditorView.editable.of(false),
    EditorState.readOnly.of(true),
    EditorView.theme({
        ".cm-content": { fontSize: "11.5px" },
        ".cm-scroller": { lineHeight: "1.5" },
    }),
];

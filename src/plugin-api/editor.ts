import { StreamLanguage } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
export { html } from "@codemirror/lang-html";
export { javascript } from "@codemirror/lang-javascript";
export { json } from "@codemirror/lang-json";
export { markdown } from "@codemirror/lang-markdown";
export { EditorState, Prec, RangeSetBuilder, StateEffect, type Extension } from "@codemirror/state";
export { Decoration, EditorView, ViewPlugin, keymap, placeholder, type DecorationSet, type ViewUpdate } from "@codemirror/view";
export { basicSetup } from "codemirror";
export { auraExtensions } from "../editor/codemirror";
export { registerView } from "../themes/bus";

export type SqlDialect = "postgres" | "mysql" | "sqlite";

/** SQL highlighting in one engine's dialect, downloaded the first time it is asked for. */
export async function sqlLanguage(dialect: SqlDialect): Promise<Extension> {
    const modes = await import("@codemirror/legacy-modes/mode/sql");
    const parser = dialect === "postgres" ? modes.pgSQL : dialect === "mysql" ? modes.mySQL : modes.sqlite;
    return StreamLanguage.define({ ...parser, languageData: { commentTokens: { line: "--", block: { open: "/*", close: "*/" } } } });
}

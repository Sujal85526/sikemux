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
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { lua } from "@codemirror/legacy-modes/mode/lua";
import { nginx } from "@codemirror/legacy-modes/mode/nginx";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { hcl, makefile } from "./langs";
import type { Extension } from "@codemirror/state";

export function languageFor(path: string): Extension[] {
    const file = path.split("/").pop()?.toLowerCase() ?? "";
    if (file === "makefile" || file === "gnumakefile" || file.endsWith(".mk")) return [StreamLanguage.define(makefile)];
    if (file === "dockerfile" || file.startsWith("dockerfile.")) return [StreamLanguage.define(dockerFile)];
    // dotenv: .env, .env.local, .env.production, .env.example, etc.
    if (file === ".env" || file.startsWith(".env.")) return [StreamLanguage.define(properties)];

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

export const auraExtensions: Extension = themeCompartmentExtension();

/**
 * Docs larger than this skip the per-change / high-frequency extensions
 * (git diff gutter, LSP hover-link mousemove). CodeMirror itself virtualizes
 * the viewport fine; these are the extensions that do work proportional to the
 * whole document or fire on every mouse move.
 */
export const LARGE_DOC_BYTES = 256 * 1024;

export function isLargeDoc(content: string): boolean {
    return content.length > LARGE_DOC_BYTES;
}

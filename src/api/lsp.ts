import { invokeCommand as invoke } from "./invoke";

export interface LspPos {
    line: number;
    character: number;
}

export interface LspRange {
    start: LspPos;
    end: LspPos;
}

export interface LspLocation {
    uri: string;
    range: LspRange;
}

export type LspLocationKind = "definition" | "declaration" | "typeDefinition" | "implementation" | "references";

export interface LspTextChange {
    range?: LspRange;
    rangeLength?: number;
    text: string;
}

export function languageFromPath(path: string): string | null {
    const file = path.split("/").pop()?.toLowerCase() ?? "";
    const ext = file.includes(".") ? file.slice(file.lastIndexOf(".") + 1) : "";
    if (["ts", "tsx", "mts", "cts"].includes(ext)) return "typescript";
    if (["js", "jsx", "mjs", "cjs"].includes(ext)) return "javascript";
    if (ext === "go") return "go";
    if (ext === "rs") return "rust";
    if (ext === "py") return "python";
    return null;
}

export function documentLanguageIdFromPath(path: string): string | null {
    const file = path.split("/").pop()?.toLowerCase() ?? "";
    const ext = file.includes(".") ? file.slice(file.lastIndexOf(".") + 1) : "";
    if (["ts", "mts", "cts"].includes(ext)) return "typescript";
    if (ext === "tsx") return "typescriptreact";
    if (["js", "mjs", "cjs"].includes(ext)) return "javascript";
    if (ext === "jsx") return "javascriptreact";
    if (ext === "go") return "go";
    if (ext === "rs") return "rust";
    if (ext === "py") return "python";
    return null;
}

export const uriToPath = (uri: string): string => {
    if (!uri.startsWith("file://")) return uri;
    try {
        const url = new URL(uri);
        return decodeURIComponent(url.pathname);
    } catch {
        return decodeURIComponent(uri.slice("file://".length));
    }
};

export const lsp = {
    start: (project: string, language: string) => invoke<void>("lsp_start", { project, language }),
    stop: (project: string) => invoke<void>("lsp_stop", { project }),
    install: (language: string) => invoke<string>("lsp_install_server", { language }),
    open: (project: string, language: string, path: string, content: string, languageId: string = language) =>
        invoke<void>("lsp_open", { project, language, path, content, languageId }),
    change: (project: string, language: string, path: string, content: string, version: number) =>
        invoke<void>("lsp_change", { project, language, path, content, version }),
    changeIncremental: (project: string, language: string, path: string, changes: LspTextChange[], version: number) =>
        invoke<void>("lsp_change_incremental", { project, language, path, changes, version }),
    save: (project: string, language: string, path: string, content?: string | null) =>
        invoke<void>("lsp_save", { project, language, path, content: content ?? null }),
    close: (project: string, language: string, path: string) => invoke<void>("lsp_close", { project, language, path }),
    locations: (project: string, language: string, path: string, line: number, character: number, kind: LspLocationKind) =>
        invoke<LspLocation[]>("lsp_locations", {
            project,
            language,
            path,
            line,
            character,
            kind,
        }),
    definition: (project: string, language: string, path: string, line: number, character: number) =>
        lsp.locations(project, language, path, line, character, "definition"),
    declaration: (project: string, language: string, path: string, line: number, character: number) =>
        lsp.locations(project, language, path, line, character, "declaration"),
    typeDefinition: (project: string, language: string, path: string, line: number, character: number) =>
        lsp.locations(project, language, path, line, character, "typeDefinition"),
    implementation: (project: string, language: string, path: string, line: number, character: number) =>
        lsp.locations(project, language, path, line, character, "implementation"),
    references: (project: string, language: string, path: string, line: number, character: number) =>
        lsp.locations(project, language, path, line, character, "references"),
};

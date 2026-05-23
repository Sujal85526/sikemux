import { invoke } from "@tauri-apps/api/core";

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

// Pick a language id from a file path; null if no LSP server is configured.
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

export const uriToPath = (uri: string): string =>
  uri.startsWith("file://") ? decodeURIComponent(uri.slice("file://".length)) : uri;

export const lsp = {
  start: (project: string, language: string) =>
    invoke<void>("lsp_start", { project, language }),
  open: (project: string, language: string, path: string, content: string) =>
    invoke<void>("lsp_open", { project, language, path, content }),
  change: (
    project: string,
    language: string,
    path: string,
    content: string,
    version: number,
  ) => invoke<void>("lsp_change", { project, language, path, content, version }),
  definition: (
    project: string,
    language: string,
    path: string,
    line: number,
    character: number,
  ) =>
    invoke<LspLocation[]>("lsp_definition", {
      project,
      language,
      path,
      line,
      character,
    }),
  implementation: (
    project: string,
    language: string,
    path: string,
    line: number,
    character: number,
  ) =>
    invoke<LspLocation[]>("lsp_implementation", {
      project,
      language,
      path,
      line,
      character,
    }),
  references: (
    project: string,
    language: string,
    path: string,
    line: number,
    character: number,
  ) =>
    invoke<LspLocation[]>("lsp_references", {
      project,
      language,
      path,
      line,
      character,
    }),
};

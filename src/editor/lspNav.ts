import { type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { languageFromPath, lsp, uriToPath } from "../api/lsp";
import { openLspPeek } from "./lspPeek";
import { swallow } from "../state/toast";

// Per-file context (project, path, navigation callback) needed by the
// Cmd-click handler. Held in a module ref so we don't have to reconfigure
// the CM state on every file switch.

export interface LspContext {
  project: string;
  path: string;
  navigate: (path: string, line: number, character: number) => void;
}

let current: LspContext | null = null;

export function setLspContext(ctx: LspContext | null) {
  current = ctx;
}

// Cmd-click (Ctrl on Linux/Win) → definition. Cmd-Shift-click → references.
// Cmd-Alt-click → implementations. Single-result definitions/implementations
// jump immediately; multi-result and all references open a popup picker.
export function lspNav(): Extension {
  return EditorView.domEventHandlers({
    mousedown(event, view) {
      if (!(event.metaKey || event.ctrlKey)) return false;
      if (event.button !== 0) return false;
      const ctx = current;
      if (!ctx) return false;
      const lang = languageFromPath(ctx.path);
      if (!lang) return false;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos == null) return false;
      const line = view.state.doc.lineAt(pos);
      const character = pos - line.from;
      event.preventDefault();

      const kind: "references" | "implementation" | "definition" = event.shiftKey
        ? "references"
        : event.altKey
          ? "implementation"
          : "definition";
      const title =
        kind === "references"
          ? "References"
          : kind === "implementation"
            ? "Implementations"
            : "Definitions";
      const fn =
        kind === "references"
          ? lsp.references
          : kind === "implementation"
            ? lsp.implementation
            : lsp.definition;

      void fn(ctx.project, lang, ctx.path, line.number - 1, character)
        .then((locs) => {
          if (locs.length === 0) return;
          // For definition / implementation with one hit, jump directly.
          if (kind !== "references" && locs.length === 1) {
            const t = locs[0];
            ctx.navigate(
              uriToPath(t.uri),
              t.range.start.line,
              t.range.start.character,
            );
            return;
          }
          // Multi-result or references → inline peek panel below the click.
          openLspPeek(view, {
            atLine: line.number - 1,
            title,
            items: locs.map((l) => ({
              uri: l.uri,
              line: l.range.start.line,
              character: l.range.start.character,
            })),
          });
        })
        .catch(swallow("lsp definition"));
      return true;
    },
  });
}

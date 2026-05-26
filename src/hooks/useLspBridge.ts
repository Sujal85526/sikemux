import { useCallback, useRef } from "react";
import { languageFromPath, lsp } from "../api/lsp";
import { swallow } from "../state/toast";

// Owns per-file LSP versions and the debounced didChange pipe. Returns:
//   - `openDoc(path, content)`: send didOpen + start the server.
//   - `scheduleChange(path, content)`: debounced didChange.
//   - `setVersion(path, n)`: explicit version override (after open).
export function useLspBridge(cwd: string) {
  const versions = useRef<Map<string, number>>(new Map());
  const timers = useRef<Map<string, number>>(new Map());

  const scheduleChange = useCallback(
    (path: string, content: string) => {
      if (!cwd) return;
      const lang = languageFromPath(path);
      if (!lang) return;
      const prior = timers.current.get(path);
      if (prior) window.clearTimeout(prior);
      const id = window.setTimeout(() => {
        const v = (versions.current.get(path) ?? 1) + 1;
        versions.current.set(path, v);
        lsp.change(cwd, lang, path, content, v).catch(swallow("lsp didChange"));
      }, 300);
      timers.current.set(path, id);
    },
    [cwd],
  );

  const openDoc = useCallback(
    async (path: string, content: string) => {
      const lang = languageFromPath(path);
      if (!lang || !cwd) return;
      try {
        await lsp.start(cwd, lang);
        await lsp.open(cwd, lang, path, content);
        versions.current.set(path, 1);
      } catch {
        /* server binary missing / handshake failed — silent */
      }
    },
    [cwd],
  );

  return { openDoc, scheduleChange };
}

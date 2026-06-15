import { useCallback, useRef } from "react";
import { documentLanguageIdFromPath, languageFromPath, lsp } from "../api/lsp";
import { swallow } from "../state/toast";

export function useLspBridge(cwd: string) {
    const versions = useRef<Map<string, number>>(new Map());
    const timers = useRef<Map<string, number>>(new Map());
    const opened = useRef<Set<string>>(new Set());

    const scheduleChange = useCallback(
        (path: string, getContent: () => string) => {
            if (!cwd) return;
            const lang = languageFromPath(path);
            if (!lang) return;
            const prior = timers.current.get(path);
            if (prior) window.clearTimeout(prior);
            const id = window.setTimeout(() => {
                const v = (versions.current.get(path) ?? 1) + 1;
                versions.current.set(path, v);
                // Serialize the doc once here, in the debounce — not on every keystroke.
                lsp.change(cwd, lang, path, getContent(), v).catch(swallow("lsp didChange"));
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
                const key = `${lang}:${path}`;
                if (!opened.current.has(key)) {
                    await lsp.open(cwd, lang, path, content, documentLanguageIdFromPath(path) ?? lang);
                    versions.current.set(path, 1);
                    opened.current.add(key);
                    return;
                }
                const v = (versions.current.get(path) ?? 1) + 1;
                versions.current.set(path, v);
                await lsp.change(cwd, lang, path, content, v);
            } catch {}
        },
        [cwd],
    );

    return { openDoc, scheduleChange };
}

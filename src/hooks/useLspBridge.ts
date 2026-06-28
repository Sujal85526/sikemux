import { useCallback, useEffect, useRef } from "react";
import { documentLanguageIdFromPath, languageFromPath, lsp, type LspTextChange } from "../api/lsp";
import { dismissToast, errCategory, errMessage, notify, swallow } from "../state/toast";

const CHANGE_DEBOUNCE_MS = 120;
const MAX_INCREMENTAL_BATCH = 80;

const INSTALLABLE_LSP: Record<string, { bin: string; label: string }> = {
    go: { bin: "gopls", label: "Go LSP" },
};

function openKey(lang: string, path: string) {
    return `${lang}\0${path}`;
}

function isInstallableMissingServer(lang: string, err: unknown, msg: string): boolean {
    const spec = INSTALLABLE_LSP[lang];
    if (!spec) return false;
    if (errCategory(err) === "lsp-server-missing") return msg.includes(`\`${spec.bin}\``);
    return new RegExp(`spawn\\s+${spec.bin}\\b.*(?:no such file|not found)`, "i").test(msg);
}

export function useLspBridge(cwd: string) {
    const versions = useRef<Map<string, number>>(new Map());
    const timers = useRef<Map<string, number>>(new Map());
    const opened = useRef<Set<string>>(new Set());
    const pendingChanges = useRef<Map<string, LspTextChange[]>>(new Map());
    const pendingFull = useRef<Map<string, () => string>>(new Map());
    const chains = useRef<Map<string, Promise<void>>>(new Map());
    const reportedErrors = useRef<Set<string>>(new Set());
    const installing = useRef<Set<string>>(new Set());

    const nextVersion = useCallback((path: string): number => {
        const v = (versions.current.get(path) ?? 1) + 1;
        versions.current.set(path, v);
        return v;
    }, []);

    const installLsp = useCallback((lang: string, retry?: () => Promise<void>, toastId?: number) => {
        const spec = INSTALLABLE_LSP[lang];
        if (!spec) return;
        if (installing.current.has(lang)) {
            notify("info", `${spec.bin} install already running`);
            return;
        }
        installing.current.add(lang);
        notify("info", `Installing ${spec.bin}…`);
        void lsp
            .install(lang)
            .then(async (installedPath) => {
                reportedErrors.current.clear();
                if (toastId != null) dismissToast(toastId);
                notify("success", `Installed ${spec.bin}${installedPath ? ` at ${installedPath}` : ""}`);
                if (!retry) return;
                try {
                    await retry();
                    notify("success", `${spec.label} ready`);
                } catch (e) {
                    notify("error", `LSP ${lang} retry failed: ${errMessage(e)}`);
                }
            })
            .catch((e) => notify("error", `${spec.bin} install failed: ${errMessage(e)}`))
            .finally(() => {
                installing.current.delete(lang);
            });
    }, []);

    const reportLspError = useCallback(
        (lang: string, action: string, err: unknown, retry?: () => Promise<void>) => {
            const msg = errMessage(err);
            const key = `${lang}:${action}:${msg}`;
            if (reportedErrors.current.has(key)) return;
            reportedErrors.current.add(key);
            const spec = INSTALLABLE_LSP[lang];
            if (spec && isInstallableMissingServer(lang, err, msg)) {
                notify("error", `${spec.label} needs ${spec.bin}. Install it to enable go-to-definition and references.`, {
                    action: { label: `Install ${spec.bin}`, run: (toastId) => installLsp(lang, retry, toastId) },
                    timeoutMs: null,
                });
                return;
            }
            notify("error", `LSP ${lang} ${action}: ${msg}`);
        },
        [installLsp],
    );

    const enqueue = useCallback((path: string, run: () => Promise<void>): Promise<void> => {
        const prev = chains.current.get(path) ?? Promise.resolve();
        const next = prev.catch(() => {}).then(run);
        chains.current.set(path, next);
        void next.finally(() => {
            if (chains.current.get(path) === next) chains.current.delete(path);
        });
        return next;
    }, []);

    const openOrSyncDoc = useCallback(
        async (lang: string, path: string, content: string, key: string): Promise<void> => {
            await lsp.start(cwd, lang);
            if (!opened.current.has(key)) {
                await lsp.open(cwd, lang, path, content, documentLanguageIdFromPath(path) ?? lang);
                versions.current.set(path, 1);
                opened.current.add(key);
                return;
            }
            const v = nextVersion(path);
            await lsp.change(cwd, lang, path, content, v);
        },
        [cwd, nextVersion],
    );

    const openDoc = useCallback(
        (path: string, content: string): Promise<void> => {
            const lang = languageFromPath(path);
            if (!lang || !cwd) return Promise.resolve();
            const key = openKey(lang, path);
            return enqueue(path, async () => {
                try {
                    await openOrSyncDoc(lang, path, content, key);
                } catch (e) {
                    reportLspError(lang, "open", e, () => enqueue(path, () => openOrSyncDoc(lang, path, content, key)));
                }
            });
        },
        [cwd, enqueue, openOrSyncDoc, reportLspError],
    );

    const scheduleChange = useCallback(
        (path: string, getContent: () => string, changes?: LspTextChange[] | null) => {
            if (!cwd) return;
            const lang = languageFromPath(path);
            if (!lang) return;

            if (changes && changes.length > 0 && !pendingFull.current.has(path)) {
                const queued = pendingChanges.current.get(path) ?? [];
                const next = queued.concat(changes);
                if (next.length <= MAX_INCREMENTAL_BATCH) {
                    pendingChanges.current.set(path, next);
                } else {
                    pendingChanges.current.delete(path);
                    pendingFull.current.set(path, getContent);
                }
            } else {
                pendingChanges.current.delete(path);
                pendingFull.current.set(path, getContent);
            }

            const prior = timers.current.get(path);
            if (prior) window.clearTimeout(prior);
            const id = window.setTimeout(() => {
                timers.current.delete(path);
                const fullGetter = pendingFull.current.get(path);
                const queued = pendingChanges.current.get(path) ?? [];
                pendingFull.current.delete(path);
                pendingChanges.current.delete(path);
                if (!fullGetter && queued.length === 0) return;

                void enqueue(path, async () => {
                    try {
                        await lsp.start(cwd, lang);
                        const key = openKey(lang, path);
                        if (!opened.current.has(key)) {
                            // If a user edits before the didOpen handshake settles, open with
                            // the latest full document and drop the queued deltas — applying
                            // them after didOpen would duplicate the edit.
                            await lsp.open(cwd, lang, path, (fullGetter ?? getContent)(), documentLanguageIdFromPath(path) ?? lang);
                            versions.current.set(path, 1);
                            opened.current.add(key);
                            return;
                        }
                        if (fullGetter) {
                            const v = nextVersion(path);
                            await lsp.change(cwd, lang, path, fullGetter(), v);
                            return;
                        }
                        for (const change of queued) {
                            const v = nextVersion(path);
                            await lsp.changeIncremental(cwd, lang, path, [change], v);
                        }
                    } catch (e) {
                        reportLspError(lang, "change", e);
                    }
                });
            }, CHANGE_DEBOUNCE_MS);
            timers.current.set(path, id);
        },
        [cwd, enqueue, nextVersion, reportLspError],
    );

    const saveDoc = useCallback(
        (path: string, content?: string | null): Promise<void> => {
            const lang = languageFromPath(path);
            if (!lang || !cwd) return Promise.resolve();
            const prior = timers.current.get(path);
            if (prior) window.clearTimeout(prior);
            timers.current.delete(path);
            pendingChanges.current.delete(path);
            pendingFull.current.delete(path);
            return enqueue(path, async () => {
                try {
                    await lsp.start(cwd, lang);
                    const key = openKey(lang, path);
                    if (content != null) {
                        if (!opened.current.has(key)) {
                            await lsp.open(cwd, lang, path, content, documentLanguageIdFromPath(path) ?? lang);
                            versions.current.set(path, 1);
                            opened.current.add(key);
                        } else {
                            const v = nextVersion(path);
                            await lsp.change(cwd, lang, path, content, v);
                        }
                    }
                    await lsp.save(cwd, lang, path, content ?? null);
                } catch (e) {
                    swallow("lsp didSave")(e);
                }
            });
        },
        [cwd, enqueue, nextVersion],
    );

    const closeDoc = useCallback(
        (path: string): Promise<void> => {
            const lang = languageFromPath(path);
            if (!lang || !cwd) return Promise.resolve();
            const key = openKey(lang, path);
            opened.current.delete(key);
            const prior = timers.current.get(path);
            if (prior) window.clearTimeout(prior);
            timers.current.delete(path);
            pendingChanges.current.delete(path);
            pendingFull.current.delete(path);
            versions.current.delete(path);
            return enqueue(path, async () => {
                try {
                    await lsp.close(cwd, lang, path);
                } catch (e) {
                    swallow("lsp didClose")(e);
                }
            });
        },
        [cwd, enqueue],
    );

    useEffect(() => {
        return () => {
            for (const timer of timers.current.values()) window.clearTimeout(timer);
            timers.current.clear();
            pendingChanges.current.clear();
            pendingFull.current.clear();
            const docs = [...opened.current];
            opened.current.clear();
            versions.current.clear();
            for (const key of docs) {
                const sep = key.indexOf("\0");
                if (sep < 0) continue;
                const lang = key.slice(0, sep);
                const path = key.slice(sep + 1);
                void lsp.close(cwd, lang, path).catch(swallow("lsp didClose"));
            }
        };
    }, [cwd]);

    return { openDoc, scheduleChange, saveDoc, closeDoc };
}

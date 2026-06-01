import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { copyLineDown, copyLineUp, indentWithTab } from "@codemirror/commands";
import { search } from "@codemirror/search";
import { basicSetup } from "codemirror";
import { auraExtensions, languageFor } from "../editor/codemirror";
import { gitDiffGutter } from "../editor/gitGutter";
import { lspNav, setLspContext } from "../editor/lspNav";
import { lspHoverLink, setHoverLinkContext } from "../editor/lspHoverLink";
import { lspPeek } from "../editor/lspPeek";
import { fsapi } from "../api/fs";
import { subscribe } from "../state/bus";
import * as cmd from "../state/commands";
import { invalidate } from "../state/resources";
import { useStore } from "../state/store";
import { reportError } from "../state/toast";
import { refreshViewTheme, registerView } from "../themes/bus";
import { useLspBridge } from "../hooks/useLspBridge";
import { useNavHistory, type NavEntry } from "../hooks/useNavHistory";
import { useGitBaseline } from "../hooks/useGitBaseline";
import { FileTree } from "./FileTree";
import { IconClose, IconFile } from "./Icons";
import { FileIcon } from "./FileIcon";
import { EditorFindBar } from "./EditorFindBar";
import { basename } from "../lib/paths";

const DEFAULT_VIEW = { openTabs: [], activePath: null, treeWidth: 210 };

function readSelection(view: EditorView): string | null {
    const sel = view.state.selection.main;
    if (sel.empty) return null;
    const raw = view.state.sliceDoc(sel.from, sel.to);
    const trimmed = raw
        .split(/\r?\n/)
        .find((l) => l.trim().length > 0)
        ?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : null;
}

function scrollToLine(view: EditorView, line: number, character: number) {
    const lineCount = view.state.doc.lines;
    const ln = Math.max(1, Math.min(line + 1, lineCount));
    const lineObj = view.state.doc.line(ln);
    const pos = Math.min(lineObj.from + Math.max(0, character), lineObj.to);
    view.dispatch({
        selection: { anchor: pos },
        effects: EditorView.scrollIntoView(pos, { y: "center" }),
    });
    view.focus();
}

export function EditorPane({ paneId, cwd, active, visible }: { paneId: string; cwd: string; active: boolean; visible: boolean }) {
    const hostRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const states = useRef<Map<string, EditorState>>(new Map());
    const currentRef = useRef<string | null>(null);
    const hydratedRef = useRef(false);
    const saveRef = useRef<() => boolean>(() => false);

    const [dirty, setDirty] = useState<ReadonlySet<string>>(() => new Set());
    const dirtyRef = useRef(dirty);
    dirtyRef.current = dirty;

    const savedRef = useRef<Map<string, string>>(new Map());

    const [findState, setFindState] = useState<{
        open: boolean;
        replaceOpen: boolean;
        seed: string | null;
        signal: number;
    }>({ open: false, replaceOpen: false, seed: null, signal: 0 });
    const openFindRef = useRef<(withReplace: boolean, seed: string | null) => void>(() => {});
    openFindRef.current = (withReplace, seed) => {
        setFindState((prev) => ({
            open: true,
            replaceOpen: withReplace || prev.replaceOpen,
            seed,
            signal: prev.signal + 1,
        }));
    };

    const view = useStore((s) => s.editorViews[paneId] ?? DEFAULT_VIEW);
    const tabs = view.openTabs;
    const activePath = view.activePath;
    const treeWidth = view.treeWidth;

    const setTreeWidth = (w: number) => cmd.setEditorView(paneId, { treeWidth: w });

    const { openDoc, scheduleChange } = useLspBridge(cwd);

    const nav = useNavHistory({
        getView: () => viewRef.current,
        getCurrentPath: () => currentRef.current,
        scrollLiveTo: (l, c) => viewRef.current && scrollToLine(viewRef.current, l, c),
        openOther: (entry: NavEntry) => cmd.requestOpenFile(entry.path, entry.line, entry.character),
    });

    const bindLspContext = (view: EditorView, path: string | null) => {
        if (!path || !cwd) {
            setLspContext(view, null);
            setHoverLinkContext(view, null);
            return;
        }
        setHoverLinkContext(view, { project: cwd, path });
        setLspContext(view, {
            project: cwd,
            path,
            navigate: (targetPath, line, character) => {
                nav.push({ path: targetPath, line, character });
            },
        });
    };

    const navBackRef = useRef(() => {});
    const navFwdRef = useRef(() => {});
    navBackRef.current = nav.back;
    navFwdRef.current = nav.forward;

    const save = useCallback((): boolean => {
        const path = currentRef.current;
        const view = viewRef.current;
        if (!path || !view) return false;
        const text = view.state.doc.toString();
        void fsapi
            .writeFile(path, text)
            .then(() => {
                savedRef.current.set(path, text);
                setDirty((d) => {
                    if (!d.has(path)) return d;
                    const next = new Set(d);
                    next.delete(path);
                    return next;
                });
                if (cwd) {
                    invalidate((kind, args) => (kind.startsWith("git.") || kind === "files.list") && args[0] === cwd);
                }
            })
            .catch(reportError("save"));
        return true;
    }, [cwd]);
    saveRef.current = save;

    const makeState = useCallback(
        (path: string, content: string) => {
            return EditorState.create({
                doc: content,
                extensions: [
                    basicSetup,
                    search({ top: true }),
                    auraExtensions,
                    ...languageFor(path),
                    gitDiffGutter(),
                    lspNav(),
                    lspHoverLink(),
                    lspPeek(),
                    keymap.of([indentWithTab]),
                    Prec.highest(
                        keymap.of([
                            { key: "Mod-Alt-ArrowUp", run: copyLineUp, preventDefault: true },
                            { key: "Mod-Alt-ArrowDown", run: copyLineDown, preventDefault: true },
                            { key: "Mod-s", preventDefault: true, run: () => saveRef.current() },
                            {
                                key: "Mod-[",
                                preventDefault: true,
                                run: () => {
                                    navBackRef.current();
                                    return true;
                                },
                            },
                            {
                                key: "Mod-]",
                                preventDefault: true,
                                run: () => {
                                    navFwdRef.current();
                                    return true;
                                },
                            },
                            {
                                key: "Mod-f",
                                preventDefault: true,
                                run: (view) => {
                                    openFindRef.current(false, readSelection(view));
                                    return true;
                                },
                            },
                            {
                                key: "Mod-h",
                                preventDefault: true,
                                run: (view) => {
                                    openFindRef.current(true, readSelection(view));
                                    return true;
                                },
                            },
                        ]),
                    ),
                    EditorView.updateListener.of((u) => {
                        if (u.docChanged && currentRef.current) {
                            const p = currentRef.current;
                            const text = u.state.doc.toString();
                            const baseline = savedRef.current.get(p);
                            const isDirty = baseline === undefined ? true : text !== baseline;
                            const has = dirtyRef.current.has(p);
                            if (isDirty && !has) {
                                setDirty((d) => new Set(d).add(p));
                            } else if (!isDirty && has) {
                                setDirty((d) => {
                                    const next = new Set(d);
                                    next.delete(p);
                                    return next;
                                });
                            }
                            scheduleChange(p, text);
                        }
                    }),
                ],
            });
        },
        [scheduleChange],
    );

    useEffect(() => {
        const view = new EditorView({ parent: hostRef.current!, state: makeState("", "") });
        viewRef.current = view;
        const unregister = registerView(view);
        return () => {
            unregister();
            view.destroy();
        };
    }, [makeState]);

    useEffect(() => {
        if (active) viewRef.current?.focus();
    }, [active, activePath]);

    const switchTo = (path: string, fresh?: EditorState) => {
        const view = viewRef.current;
        if (!view) return;
        if (currentRef.current) states.current.set(currentRef.current, view.state);
        const st = fresh ?? states.current.get(path);
        if (!st) return;
        view.setState(st);
        refreshViewTheme(view);
        currentRef.current = path;
        bindLspContext(view, path);
        void openDoc(path, view.state.doc.toString());
        cmd.setEditorView(paneId, { activePath: path });
        view.focus();
    };

    const openPath = async (path: string) => {
        const liveTabs = useStore.getState().editorViews[paneId]?.openTabs ?? [];
        if (liveTabs.includes(path)) {
            switchTo(path);
            return;
        }
        try {
            const content = await fsapi.readFile(path);
            const st = makeState(path, content);
            states.current.set(path, st);
            savedRef.current.set(path, content);
            cmd.setEditorView(paneId, {
                openTabs: [...liveTabs, path],
                activePath: path,
            });
            switchTo(path, st);
        } catch {}
    };

    useEffect(() => {
        if (!visible || hydratedRef.current) return;
        if (!viewRef.current) return;
        if (tabs.length === 0) return;
        let cancelled = false;
        (async () => {
            for (const path of tabs) {
                if (cancelled) return;
                if (states.current.has(path)) continue;
                try {
                    const content = await fsapi.readFile(path);
                    if (cancelled) return;
                    const st = makeState(path, content);
                    states.current.set(path, st);
                    savedRef.current.set(path, content);
                } catch {
                    cmd.setEditorView(paneId, {
                        openTabs: useStore.getState().editorViews[paneId]?.openTabs.filter((t) => t !== path) ?? [],
                    });
                }
            }
            const want = activePath && tabs.includes(activePath) ? activePath : tabs[0];
            if (want && states.current.has(want)) {
                switchTo(want);
            }
            if (!cancelled) hydratedRef.current = true;
        })();
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [visible]);

    useEffect(() => {
        if (!visible || !cwd) return;
        let cancelled = false;
        (async () => {
            const tabsNow = useStore.getState().editorViews[paneId]?.openTabs ?? [];
            for (const path of tabsNow) {
                if (cancelled || dirtyRef.current.has(path)) continue;
                let fresh: string;
                try {
                    fresh = await fsapi.readFile(path);
                } catch {
                    continue;
                }
                if (cancelled) return;
                const isActive = currentRef.current === path;
                const view = viewRef.current;
                if (isActive && view) {
                    const current = view.state.doc.toString();
                    if (current === fresh) continue;
                    const head = Math.min(view.state.selection.main.head, fresh.length);
                    view.dispatch({
                        changes: { from: 0, to: view.state.doc.length, insert: fresh },
                        selection: { anchor: head },
                    });
                } else {
                    const cached = states.current.get(path);
                    if (cached && cached.doc.toString() === fresh) continue;
                    states.current.set(path, makeState(path, fresh));
                }
                savedRef.current.set(path, fresh);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [visible, cwd, paneId, makeState]);

    useEffect(() => {
        if (!cwd || !visible) return;
        return subscribe("fs-changed", async (e) => {
            if (e.repo && e.repo !== cwd) return;
            const tabsNow = useStore.getState().editorViews[paneId]?.openTabs ?? [];
            for (const path of tabsNow) {
                if (dirtyRef.current.has(path)) continue;
                let fresh: string;
                try {
                    fresh = await fsapi.readFile(path);
                } catch {
                    continue; // file was deleted / renamed — silently skip
                }
                const isActive = currentRef.current === path;
                const view = viewRef.current;
                if (isActive && view) {
                    const current = view.state.doc.toString();
                    if (current === fresh) continue;
                    const head = Math.min(view.state.selection.main.head, fresh.length);
                    view.dispatch({
                        changes: { from: 0, to: view.state.doc.length, insert: fresh },
                        selection: { anchor: head },
                    });
                } else {
                    const cached = states.current.get(path);
                    if (cached && cached.doc.toString() === fresh) continue;
                    states.current.set(path, makeState(path, fresh));
                }
                savedRef.current.set(path, fresh);
            }
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [cwd, paneId, visible]);

    useEffect(() => {
        return subscribe("open-file", (e) => {
            if (cwd && !e.path.startsWith(`${cwd}/`) && e.path !== cwd) return;
            void (async () => {
                await openPath(e.path);
                if (e.line != null && viewRef.current) {
                    scrollToLine(viewRef.current, e.line, e.character ?? 0);
                }
            })();
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [cwd]);

    useEffect(() => {
        const view = viewRef.current;
        if (!view) return;
        if (!activePath || !cwd) {
            setLspContext(view, null);
            setHoverLinkContext(view, null);
            return;
        }
        bindLspContext(view, activePath);
        return () => {
            setLspContext(view, null);
            setHoverLinkContext(view, null);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activePath, cwd]);

    useGitBaseline(() => viewRef.current, cwd, activePath);

    const closeTab = (path: string, e: ReactMouseEvent) => {
        e.stopPropagation();
        states.current.delete(path);
        setDirty((d) => {
            if (!d.has(path)) return d;
            const next = new Set(d);
            next.delete(path);
            return next;
        });
        const next = tabs.filter((t) => t !== path);
        let nextActive = activePath;
        if (activePath === path) {
            const fallback = next[next.length - 1] ?? null;
            nextActive = fallback;
            if (fallback) {
                switchTo(fallback);
            } else {
                currentRef.current = null;
                viewRef.current?.setState(makeState("", ""));
            }
        }
        cmd.setEditorView(paneId, { openTabs: next, activePath: nextActive });
    };

    return (
        <div className="editor-pane">
            <FileTree
                cwd={cwd}
                activePath={activePath}
                onOpenFile={(entry) => void openPath(entry.path)}
                width={treeWidth}
                onResize={setTreeWidth}
                active={visible}
            />
            <div className="ed-main">
                <div className="ed-tabs">
                    {tabs.map((path) => {
                        const name = basename(path);
                        return (
                            <button key={path} className={`ed-tab${activePath === path ? " active" : ""}`} onClick={() => switchTo(path)}>
                                <FileIcon name={name} size={18} />
                                <span className="ed-tab-name">{name}</span>
                                {dirty.has(path) && <span className="ed-tab-dot" />}
                                <span className="ed-tab-x" onClick={(e) => closeTab(path, e)}>
                                    <IconClose size={10} />
                                </span>
                            </button>
                        );
                    })}
                </div>
                <div className="ed-host" ref={hostRef}>
                    <EditorFindBar
                        getView={() => viewRef.current}
                        open={findState.open}
                        replaceOpenOnMount={findState.replaceOpen}
                        seed={findState.seed}
                        signal={findState.signal}
                        onClose={() => setFindState((prev) => ({ ...prev, open: false }))}
                    />
                </div>
                {tabs.length === 0 && (
                    <div className="ed-empty">
                        <IconFile size={22} />
                        <p>select a file from the tree</p>
                        <p className="ed-empty-sub">Cmd-S saves · syntax-highlighted</p>
                    </div>
                )}
            </div>
        </div>
    );
}

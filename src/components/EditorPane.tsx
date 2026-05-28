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

const DEFAULT_VIEW = { openTabs: [], activePath: null, treeWidth: 210 };

const basename = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;

// Pull the active editor selection as a single-line string. Multi-line
// selections collapse to their first non-empty line so the find input
// doesn't get filled with a giant blob. Returns null if nothing's
// selected (so the bar leaves whatever the user previously typed in).
function readSelection(view: EditorView): string | null {
    const sel = view.state.selection.main;
    if (sel.empty) return null;
    const raw = view.state.sliceDoc(sel.from, sel.to);
    const trimmed = raw.split(/\r?\n/).find((l) => l.trim().length > 0)?.trim();
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

// Native code editor: file tree + tabs + CodeMirror 6. Tabs + activePath
// + treeWidth live in store.editorViews[paneId] so layouts that re-mount
// the pane preserve them, and they persist across reloads. The CM view is
// imperative — its per-tab states live in a useRef so switching tabs
// preserves content, undo and cursor.
export function EditorPane({ paneId, cwd, active, visible }: { paneId: string; cwd: string; active: boolean; visible: boolean }) {
    const hostRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const states = useRef<Map<string, EditorState>>(new Map());
    const currentRef = useRef<string | null>(null);
    const hydratedRef = useRef(false);
    const saveRef = useRef<() => boolean>(() => false);

    // Dirty state is CM-derived and changes every keystroke — kept local
    // rather than round-tripping through the store.
    const [dirty, setDirty] = useState<ReadonlySet<string>>(() => new Set());
    const dirtyRef = useRef(dirty);
    dirtyRef.current = dirty;

    // Per-path snapshot of the on-disk content (set on open + on save).
    // Used in the updateListener below to compare every keystroke's doc
    // against the saved baseline — if the user undoes back to disk we
    // clear the dirty mark, instead of leaving the dot lit forever.
    const savedRef = useRef<Map<string, string>>(new Map());

    // Find/Replace bar — Mod-F opens find-only, Mod-H opens with replace
    // pre-expanded. We render our own React bar (see EditorFindBar) and
    // drive CodeMirror's search commands directly; CM's built-in panel
    // is never opened.
    //
    // `findSignal` bumps on every Mod-F/Mod-H so the bar re-focuses its
    // input (and re-seeds from selection) even when it's already open —
    // mirrors VSCode where Cmd-F on a focused editor always pulls focus
    // back to the find input and replaces its content with the current
    // selection if there is one.
    const [findState, setFindState] = useState<{
        open: boolean;
        replaceOpen: boolean;
        seed: string | null;
        signal: number;
    }>({ open: false, replaceOpen: false, seed: null, signal: 0 });
    const openFindRef = useRef<
        (withReplace: boolean, seed: string | null) => void
    >(() => {});
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

    // Nav history — Cmd-[ / Cmd-] traversal across files.
    const nav = useNavHistory({
        getView: () => viewRef.current,
        getCurrentPath: () => currentRef.current,
        scrollLiveTo: (l, c) => viewRef.current && scrollToLine(viewRef.current, l, c),
        openOther: (entry: NavEntry) => cmd.requestOpenFile(entry.path, entry.line, entry.character),
    });

    // The CM keymap needs stable callbacks; bind to refs that always read the
    // latest hook closures.
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
                // Saved content IS the new baseline — future undos
                // back to here should keep the tab clean.
                savedRef.current.set(path, text);
                setDirty((d) => {
                    if (!d.has(path)) return d;
                    const next = new Set(d);
                    next.delete(path);
                    return next;
                });
                // Don't wait for the fs watcher — invalidate locally so the
                // diff gutter / git pane / file tree status decorations
                // update now. We deliberately do NOT also `emit("fs-changed")`
                // here: that would make every other open tab re-read from
                // disk through the fs-changed subscriber below, including the
                // file we just wrote. The Rust fs watcher emits a real
                // git_changed ~200ms later and that one IS scoped to actual
                // external observers.
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
                    // search panel pinned to the TOP of the editor so the in-pane CSS
                    // (top-right floating bar, compact pills) actually applies. Default
                    // is bottom, full-width, which clashes with the project's look.
                    search({ top: true }),
                    auraExtensions,
                    ...languageFor(path),
                    gitDiffGutter(),
                    lspNav(),
                    lspHoverLink(),
                    lspPeek(),
                    // Tab indents instead of moving focus out of the editor —
                    // CodeMirror 6 leaves Tab unbound by default for a11y
                    // (Tab = focus next element); for a code editor we want
                    // the "insert indent" behavior.
                    keymap.of([indentWithTab]),
                    // Prec.highest so our Mod-F / Mod-H beat the searchKeymap
                    // that ships with the search() extension — otherwise CM's
                    // built-in openSearchPanel wins the keypress and the panel
                    // mounts (then sits invisible under .cm-panels { display:
                    // none }) while our React bar never opens.
                    Prec.highest(
                        keymap.of([
                            // VSCode-style line duplication. basicSetup's
                            // defaultKeymap binds these to "add cursor above /
                            // below" at default precedence — Prec.highest here
                            // overrides that so the lines are duplicated
                            // instead of spawning a multi-cursor.
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
                            // Dirty iff the buffer no longer matches the
                            // on-disk snapshot. Re-checked on every change
                            // so undoing back to the saved content clears
                            // the tab's dot.
                            const isDirty = baseline === undefined
                                ? true
                                : text !== baseline;
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

    // Mount CM once. Register with the theme bus so it reconfigures on
    // theme change.
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
        // Per-tab states carry the theme that was active at save-time; push the
        // current theme so tab switching never restores stale colors.
        refreshViewTheme(view);
        currentRef.current = path;
        cmd.setEditorView(paneId, { activePath: path });
        view.focus();
    };

    const openPath = async (path: string) => {
        // Read tabs fresh from the store on every call. The `open-file`
        // subscriber below captures this function once (its useEffect only
        // depends on cwd), so closing over the rendered `tabs` would make
        // every cmd-P open after the first see an empty list and clobber
        // the previously-opened tabs.
        const liveTabs =
            useStore.getState().editorViews[paneId]?.openTabs ?? [];
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
            // CM transition happens after the store update lands; switchTo also
            // dispatches the active-path patch but it's idempotent.
            switchTo(path, st);
            void openDoc(path, content);
        } catch {
            /* unreadable (binary, perms) — ignore */
        }
    };

    // Hydrate CM with tabs persisted across reloads. Hidden project panes are
    // mounted for state preservation, so defer the file reads until the editor
    // is actually visible.
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
                    /* file gone — drop it */
                    cmd.setEditorView(paneId, {
                        openTabs: useStore.getState().editorViews[paneId]?.openTabs.filter((t) => t !== path) ?? [],
                    });
                }
            }
            // Restore the previously-active tab.
            const want = activePath && tabs.includes(activePath) ? activePath : tabs[0];
            if (want && states.current.has(want)) {
                switchTo(want);
                const content = states.current.get(want)?.doc.toString() ?? "";
                void openDoc(want, content);
            }
            if (!cancelled) hydratedRef.current = true;
        })();
        return () => {
            cancelled = true;
        };
        // Only fire once at mount; tabs/activePath churn afterwards is normal.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [visible]);

    // On activation, catch up clean tabs with disk. This covers background
    // agent writes that happened while the project watcher/editor subscriber
    // was intentionally inactive.
    //
    // `tabs.length` was previously in the deps, which caused this effect to
    // re-fire (and read every tab from disk) whenever the user opened or
    // closed a tab. openPath already does the read for new tabs, and the
    // visible-pane fs-changed subscriber below keeps existing tabs in sync —
    // so resync is only needed at the visibility transition.
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

    // Live external-edit reload. When fs_watch fires for our repo (agent
    // wrote a file, git checkout swapped contents, etc.), re-read every
    // open tab and push fresh content into its EditorState. Dirty tabs are
    // skipped — never clobber the user's in-flight edits. Zed-style: the
    // editor always matches disk unless the user has unsaved changes.
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
                    // Preserve cursor offset where possible (clamp to new length).
                    const head = Math.min(view.state.selection.main.head, fresh.length);
                    view.dispatch({
                        changes: { from: 0, to: view.state.doc.length, insert: fresh },
                        selection: { anchor: head },
                    });
                } else {
                    const cached = states.current.get(path);
                    if (cached && cached.doc.toString() === fresh) continue;
                    // Cold tab: rebuild its EditorState so the next switchTo lands
                    // on the new content. Cursor falls back to start since the
                    // stored selection may no longer be meaningful.
                    states.current.set(path, makeState(path, fresh));
                }
                // External write became the new on-disk baseline — future
                // edits compare against this so dirty stays accurate.
                savedRef.current.set(path, fresh);
            }
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [cwd, paneId, visible]);

    // Open-file events from the bus (Cmd-P palette, git review jump, LSP nav).
    useEffect(() => {
        return subscribe("open-file", (e) => {
            // Only the pane whose cwd contains the file should react.
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

    // LSP nav + hover-link contexts.
    useEffect(() => {
        if (!activePath || !cwd) {
            setLspContext(null);
            setHoverLinkContext(null);
            return;
        }
        setHoverLinkContext({ project: cwd, path: activePath });
        setLspContext({
            project: cwd,
            path: activePath,
            navigate: (targetPath, line, character) => {
                nav.push({ path: targetPath, line, character });
            },
        });
        return () => {
            setLspContext(null);
            setHoverLinkContext(null);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activePath, cwd]);

    // Git baseline for the diff gutter.
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
                        onClose={() =>
                            setFindState((prev) => ({ ...prev, open: false }))
                        }
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

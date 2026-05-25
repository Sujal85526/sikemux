import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { search } from "@codemirror/search";
import { basicSetup } from "codemirror";
import { auraExtensions, languageFor } from "../editor/codemirror";
import { gitDiffGutter } from "../editor/gitGutter";
import { lspNav, setLspContext } from "../editor/lspNav";
import { lspHoverLink, setHoverLinkContext } from "../editor/lspHoverLink";
import { lspPeek } from "../editor/lspPeek";
import { fsapi } from "../api/fs";
import { emit, subscribe } from "../state/bus";
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

const DEFAULT_VIEW = { openTabs: [], activePath: null, treeWidth: 210 };

const basename = (p: string) =>
  p.replace(/\/+$/, "").split("/").pop() || p;

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
export function EditorPane({
  paneId,
  cwd,
  active,
}: {
  paneId: string;
  cwd: string;
  active: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const states = useRef<Map<string, EditorState>>(new Map());
  const currentRef = useRef<string | null>(null);
  const saveRef = useRef<() => boolean>(() => false);

  // Dirty state is CM-derived and changes every keystroke — kept local
  // rather than round-tripping through the store.
  const [dirty, setDirty] = useState<ReadonlySet<string>>(() => new Set());
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

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
    openOther: (entry: NavEntry) =>
      cmd.requestOpenFile(entry.path, entry.line, entry.character),
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
    void fsapi
      .writeFile(path, view.state.doc.toString())
      .then(() => {
        setDirty((d) => {
          if (!d.has(path)) return d;
          const next = new Set(d);
          next.delete(path);
          return next;
        });
        // Don't wait for the fs watcher — invalidate locally so the diff
        // gutter / git pane / file tree status decorations update now.
        if (cwd) {
          invalidate(
            (kind, args) =>
              (kind.startsWith("git.") || kind === "files.list") &&
              args[0] === cwd,
          );
          emit({ type: "fs-changed", repo: cwd });
        }
      })
      .catch(reportError("save"));
    return true;
  }, [cwd]);
  saveRef.current = save;

  const makeState = useCallback((path: string, content: string) => {
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
        keymap.of([
          { key: "Mod-s", preventDefault: true, run: () => saveRef.current() },
          { key: "Mod-[", preventDefault: true, run: () => { navBackRef.current(); return true; } },
          { key: "Mod-]", preventDefault: true, run: () => { navFwdRef.current(); return true; } },
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged && currentRef.current) {
            const p = currentRef.current;
            if (!dirtyRef.current.has(p)) {
              setDirty((d) => new Set(d).add(p));
            }
            scheduleChange(p, u.state.doc.toString());
          }
        }),
      ],
    });
  }, [scheduleChange]);

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
    if (tabs.includes(path)) {
      switchTo(path);
      return;
    }
    try {
      const content = await fsapi.readFile(path);
      const st = makeState(path, content);
      states.current.set(path, st);
      cmd.setEditorView(paneId, {
        openTabs: [...tabs, path],
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

  // Hydrate CM with tabs persisted across reloads. Runs once on mount when
  // the store already has a list of openTabs (from boot_init's snapshot).
  useEffect(() => {
    if (!viewRef.current) return;
    if (states.current.size > 0) return;
    if (tabs.length === 0) return;
    let cancelled = false;
    (async () => {
      for (const path of tabs) {
        if (cancelled) return;
        try {
          const content = await fsapi.readFile(path);
          if (cancelled) return;
          const st = makeState(path, content);
          states.current.set(path, st);
        } catch {
          /* file gone — drop it */
          cmd.setEditorView(paneId, {
            openTabs: useStore
              .getState()
              .editorViews[paneId]?.openTabs.filter((t) => t !== path) ?? [],
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
    })();
    return () => {
      cancelled = true;
    };
    // Only fire once at mount; tabs/activePath churn afterwards is normal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live external-edit reload. When fs_watch fires for our repo (agent
  // wrote a file, git checkout swapped contents, etc.), re-read every
  // open tab and push fresh content into its EditorState. Dirty tabs are
  // skipped — never clobber the user's in-flight edits. Zed-style: the
  // editor always matches disk unless the user has unsaved changes.
  useEffect(() => {
    if (!cwd) return;
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
          const head = Math.min(
            view.state.selection.main.head,
            fresh.length,
          );
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
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, paneId]);

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
      />
      <div className="ed-main">
        <div className="ed-tabs">
          {tabs.map((path) => {
            const name = basename(path);
            return (
              <button
                key={path}
                className={`ed-tab${activePath === path ? " active" : ""}`}
                onClick={() => switchTo(path)}
              >
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
        <div className="ed-host" ref={hostRef} />
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

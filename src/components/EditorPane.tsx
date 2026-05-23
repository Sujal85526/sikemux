import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { auraExtensions, languageFor } from "../editor/codemirror";
import { gitDiffGutter } from "../editor/gitGutter";
import { lspNav, setLspContext } from "../editor/lspNav";
import { lspHoverLink, setHoverLinkContext } from "../editor/lspHoverLink";
import { lspPeek } from "../editor/lspPeek";
import { fsapi } from "../api/fs";
import { useWorkspace } from "../state/workspace";
import { reportError } from "../state/toast";
import { useLspBridge } from "../hooks/useLspBridge";
import { useNavHistory, type NavEntry } from "../hooks/useNavHistory";
import { useGitBaseline } from "../hooks/useGitBaseline";
import { FileTree } from "./FileTree";
import { IconClose, IconFile } from "./Icons";
import { FileIcon } from "./FileIcon";

interface Tab {
  path: string;
  name: string;
  dirty: boolean;
}

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

// Native code editor: file tree + tabs + CodeMirror 6. The CM view is mounted
// imperatively and lives outside React's render tree; per-tab EditorStates are
// stashed in a ref so switching tabs preserves content, undo and cursor.
export function EditorPane({ cwd, active }: { cwd: string; active: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const states = useRef<Map<string, EditorState>>(new Map());
  const currentRef = useRef<string | null>(null);
  const saveRef = useRef<() => boolean>(() => false);

  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [treeWidth, setTreeWidth] = useState<number>(() => {
    const stored = Number(localStorage.getItem("sikemux:treeWidth"));
    return Number.isFinite(stored) && stored >= 160 && stored <= 600 ? stored : 210;
  });

  const openRequest = useWorkspace((s) => s.openRequest);
  const requestOpenFile = useWorkspace((s) => s.requestOpenFile);

  const { openDoc, scheduleChange } = useLspBridge(cwd);

  // Nav history — Cmd-[ / Cmd-] traversal across files.
  const nav = useNavHistory({
    getView: () => viewRef.current,
    getCurrentPath: () => currentRef.current,
    scrollLiveTo: (l, c) => viewRef.current && scrollToLine(viewRef.current, l, c),
    openOther: (entry: NavEntry) =>
      requestOpenFile(entry.path, entry.line, entry.character),
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
        setTabs((ts) =>
          ts.map((t) => (t.path === path ? { ...t, dirty: false } : t)),
        );
        useWorkspace.getState().bumpGitRefresh();
      })
      .catch(reportError("save"));
    return true;
  }, []);
  saveRef.current = save;

  const makeState = useCallback((path: string, content: string) => {
    return EditorState.create({
      doc: content,
      extensions: [
        basicSetup,
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
            setTabs((ts) =>
              ts.map((t) => (t.path === p && !t.dirty ? { ...t, dirty: true } : t)),
            );
            scheduleChange(p, u.state.doc.toString());
          }
        }),
      ],
    });
  }, [scheduleChange]);

  // Mount CM once.
  useEffect(() => {
    const view = new EditorView({ parent: hostRef.current!, state: makeState("", "") });
    viewRef.current = view;
    return () => view.destroy();
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
    currentRef.current = path;
    setActivePath(path);
    view.focus();
  };

  const openPath = async (path: string) => {
    if (tabs.some((t) => t.path === path)) {
      switchTo(path);
      return;
    }
    try {
      const content = await fsapi.readFile(path);
      const st = makeState(path, content);
      states.current.set(path, st);
      setTabs((ts) => [...ts, { path, name: basename(path), dirty: false }]);
      switchTo(path, st);
      void openDoc(path, content);
    } catch {
      /* unreadable (binary, perms) — ignore */
    }
  };

  // Open requests from elsewhere (git review, LSP cross-file jump).
  useEffect(() => {
    if (!openRequest) return;
    const { path, line, character } = openRequest;
    void (async () => {
      await openPath(path);
      if (line != null && viewRef.current) {
        scrollToLine(viewRef.current, line, character ?? 0);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openRequest?.n]);

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
    setTabs((ts) => {
      const next = ts.filter((t) => t.path !== path);
      if (currentRef.current === path) {
        const fallback = next[next.length - 1];
        if (fallback) switchTo(fallback.path);
        else {
          currentRef.current = null;
          setActivePath(null);
          viewRef.current?.setState(makeState("", ""));
        }
      }
      return next;
    });
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
          {tabs.map((t) => (
            <button
              key={t.path}
              className={`ed-tab${activePath === t.path ? " active" : ""}`}
              onClick={() => switchTo(t.path)}
            >
              <FileIcon name={t.name} size={18} />
              <span className="ed-tab-name">{t.name}</span>
              {t.dirty && <span className="ed-tab-dot" />}
              <span className="ed-tab-x" onClick={(e) => closeTab(t.path, e)}>
                <IconClose size={10} />
              </span>
            </button>
          ))}
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

import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { auraExtensions, languageFor } from "../editor/codemirror";
import { fsapi, type DirEntry } from "../api/fs";
import { useWorkspace } from "../state/workspace";
import { IconChevron, IconClose, IconFile, IconFolder } from "./Icons";

interface Tab {
  path: string;
  name: string;
  dirty: boolean;
}

const basename = (p: string) =>
  p.replace(/\/+$/, "").split("/").pop() || p;

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
  const [dirs, setDirs] = useState<Record<string, DirEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const openRequest = useWorkspace((s) => s.openRequest);

  const save = useCallback((): boolean => {
    const path = currentRef.current;
    const view = viewRef.current;
    if (!path || !view) return false;
    void fsapi
      .writeFile(path, view.state.doc.toString())
      .then(() =>
        setTabs((ts) =>
          ts.map((t) => (t.path === path ? { ...t, dirty: false } : t)),
        ),
      )
      .catch(() => {});
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
        keymap.of([
          { key: "Mod-s", preventDefault: true, run: () => saveRef.current() },
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged && currentRef.current) {
            const p = currentRef.current;
            setTabs((ts) =>
              ts.map((t) => (t.path === p && !t.dirty ? { ...t, dirty: true } : t)),
            );
          }
        }),
      ],
    });
  }, []);

  // Mount CodeMirror once.
  useEffect(() => {
    const view = new EditorView({
      parent: hostRef.current!,
      state: makeState("", ""),
    });
    viewRef.current = view;
    return () => view.destroy();
  }, [makeState]);

  // Load the project root.
  useEffect(() => {
    if (!cwd) return;
    fsapi
      .readDir(cwd)
      .then((e) => setDirs((d) => ({ ...d, [cwd]: e })))
      .catch(() => {});
  }, [cwd]);

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
    } catch {
      /* unreadable (binary, perms) — ignore */
    }
  };
  const openFile = (entry: DirEntry) => void openPath(entry.path);

  // Open files requested from elsewhere (e.g. the git review's file header).
  useEffect(() => {
    if (openRequest) void openPath(openRequest.path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openRequest?.n]);

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

  const toggleDir = async (entry: DirEntry) => {
    const open = expanded.has(entry.path);
    setExpanded((s) => {
      const n = new Set(s);
      open ? n.delete(entry.path) : n.add(entry.path);
      return n;
    });
    if (!open && !dirs[entry.path]) {
      try {
        const e = await fsapi.readDir(entry.path);
        setDirs((d) => ({ ...d, [entry.path]: e }));
      } catch {
        /* ignore */
      }
    }
  };

  const renderTree = (path: string, depth: number): ReactNode => {
    const entries = dirs[path] ?? [];
    return entries.map((e) => {
      const pad = 10 + depth * 13;
      if (e.is_dir) {
        const open = expanded.has(e.path);
        return (
          <div key={e.path}>
            <button
              className="tree-row"
              style={{ paddingLeft: pad }}
              onClick={() => toggleDir(e)}
            >
              <span className={`tree-chev${open ? " open" : ""}`}>
                <IconChevron size={11} />
              </span>
              <span className="tree-folder">
                <IconFolder size={13} />
              </span>
              <span className="tree-name">{e.name}</span>
            </button>
            {open && renderTree(e.path, depth + 1)}
          </div>
        );
      }
      return (
        <button
          key={e.path}
          className={`tree-row file${activePath === e.path ? " active" : ""}`}
          style={{ paddingLeft: pad + 13 }}
          onClick={() => openFile(e)}
        >
          <span className="tree-file">
            <IconFile size={12} />
          </span>
          <span className="tree-name">{e.name}</span>
        </button>
      );
    });
  };

  return (
    <div className="editor-pane">
      <div className="ed-tree">
        <div className="ed-tree-head">{basename(cwd) || "files"}</div>
        <div className="ed-tree-scroll">{renderTree(cwd, 0)}</div>
      </div>
      <div className="ed-main">
        <div className="ed-tabs">
          {tabs.map((t) => (
            <button
              key={t.path}
              className={`ed-tab${activePath === t.path ? " active" : ""}`}
              onClick={() => switchTo(t.path)}
            >
              <IconFile size={11} />
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

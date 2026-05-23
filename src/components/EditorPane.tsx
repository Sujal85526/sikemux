import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { auraExtensions, languageFor } from "../editor/codemirror";
import { gitDiffGutter, setGitBaseline } from "../editor/gitGutter";
import { lspNav, setLspContext } from "../editor/lspNav";
import { lspHoverLink, setHoverLinkContext } from "../editor/lspHoverLink";
import { lspPeek } from "../editor/lspPeek";
import { languageFromPath, lsp } from "../api/lsp";

interface NavEntry {
  path: string;
  line: number;
  character: number;
}

// Module-level refs for the back/forward keybindings — the CM keymap needs
// stable callbacks. EditorPane assigns into these on mount.
const navBackRef = { current: (() => {}) as () => void };
const navFwdRef = { current: (() => {}) as () => void };

// Move the editor caret to (line, character) and scroll it into view. Used
// for both same-file LSP navigation and cross-file landings.
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
import { fsapi, type DirEntry } from "../api/fs";
import { git, type GitFile } from "../api/git";
import { useWorkspace } from "../state/workspace";
import { IconChevron, IconClose, IconFile, IconFolder } from "./Icons";
import { FileIcon } from "./FileIcon";

// VSCode-style decoration letter + class for a git-tracked file.
function gitDecoration(f: GitFile): { letter: string; cls: string } {
  if (f.index === "?" || f.worktree === "?") return { letter: "U", cls: "u" };
  if (f.worktree === "D" || f.index === "D") return { letter: "D", cls: "d" };
  if (f.index === "A") return { letter: "A", cls: "a" };
  if (f.index === "R" || f.worktree === "R") return { letter: "R", cls: "r" };
  if (f.worktree === "M" || f.index === "M") return { letter: "M", cls: "m" };
  return { letter: f.worktree.trim() || f.index.trim(), cls: "m" };
}

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
  const [gitMap, setGitMap] = useState<Map<string, GitFile>>(new Map());
  const openRequest = useWorkspace((s) => s.openRequest);
  const requestOpenFile = useWorkspace((s) => s.requestOpenFile);
  const gitRefreshN = useWorkspace((s) => s.gitRefreshN);

  // Git status decorations in the file tree — refetched on save (nonce bump)
  // and when the active project cwd changes.
  useEffect(() => {
    if (!cwd) {
      setGitMap(new Map());
      return;
    }
    let cancelled = false;
    git
      .status(cwd)
      .then((s) => {
        if (cancelled) return;
        const m = new Map<string, GitFile>();
        s.files.forEach((f) => m.set(`${cwd}/${f.path}`, f));
        setGitMap(m);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [cwd, gitRefreshN]);

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
        gitDiffGutter(),
        lspNav(),
        lspHoverLink(),
        lspPeek(),
        keymap.of([
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
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged && currentRef.current) {
            const p = currentRef.current;
            setTabs((ts) =>
              ts.map((t) => (t.path === p && !t.dirty ? { ...t, dirty: true } : t)),
            );
            scheduleLspChange(p, u.state.doc.toString());
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

  // Per-file LSP change debouncing — coalesce rapid edits before pushing.
  const lspVersionRef = useRef<Map<string, number>>(new Map());
  const lspTimerRef = useRef<Map<string, number>>(new Map());
  const scheduleLspChange = useCallback(
    (path: string, content: string) => {
      if (!cwd) return;
      const lang = languageFromPath(path);
      if (!lang) return;
      const prior = lspTimerRef.current.get(path);
      if (prior) window.clearTimeout(prior);
      const id = window.setTimeout(() => {
        const v = (lspVersionRef.current.get(path) ?? 1) + 1;
        lspVersionRef.current.set(path, v);
        lsp.change(cwd, lang, path, content, v).catch(() => {});
      }, 300);
      lspTimerRef.current.set(path, id);
    },
    [cwd],
  );

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
      // LSP setup is fire-and-forget so the file opens instantly even when
      // the server takes a while to initialise (gopls / first-time workspaces
      // can be slow). Cmd-click stays correct because it's only consulted
      // after the server is up.
      const lang = languageFromPath(path);
      if (lang && cwd) {
        void (async () => {
          try {
            await lsp.start(cwd, lang);
            await lsp.open(cwd, lang, path, content);
            lspVersionRef.current.set(path, 1);
          } catch {
            /* server binary missing / handshake failed — silent */
          }
        })();
      }
    } catch {
      /* unreadable (binary, perms) — ignore */
    }
  };
  const openFile = (entry: DirEntry) => void openPath(entry.path);

  // Open files requested from elsewhere (e.g. git review's file header, or
  // an LSP cross-file Cmd-click jump). Honour the optional line/character so
  // we land on the target symbol rather than the top of the file.
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

  // VSCode/Zed-style navigation history. Cmd-click pushes (current, target);
  // Cmd-[ / Cmd-] walk the stack.
  const navHistoryRef = useRef<NavEntry[]>([]);
  const navIdxRef = useRef(-1);

  const captureCurrentPos = useCallback((): NavEntry | null => {
    if (!viewRef.current || !currentRef.current) return null;
    const view = viewRef.current;
    const head = view.state.selection.main.head;
    const line = view.state.doc.lineAt(head);
    return {
      path: currentRef.current,
      line: line.number - 1,
      character: head - line.from,
    };
  }, []);

  const navigateTo = useCallback(
    (entry: NavEntry) => {
      if (entry.path === currentRef.current && viewRef.current) {
        scrollToLine(viewRef.current, entry.line, entry.character);
      } else {
        requestOpenFile(entry.path, entry.line, entry.character);
      }
    },
    [requestOpenFile],
  );

  navBackRef.current = useCallback(() => {
    if (navIdxRef.current <= 0) return;
    navIdxRef.current -= 1;
    navigateTo(navHistoryRef.current[navIdxRef.current]);
  }, [navigateTo]);

  navFwdRef.current = useCallback(() => {
    if (navIdxRef.current >= navHistoryRef.current.length - 1) return;
    navIdxRef.current += 1;
    navigateTo(navHistoryRef.current[navIdxRef.current]);
  }, [navigateTo]);

  // Update the LSP nav + hover-link contexts whenever the active file
  // changes — both extensions need to know which project + path to query.
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
        // Seed history with the click origin so the first Cmd-[ returns to it.
        const origin = captureCurrentPos();
        if (origin && navHistoryRef.current.length === 0) {
          navHistoryRef.current = [origin];
          navIdxRef.current = 0;
        }
        const target: NavEntry = { path: targetPath, line, character };
        // Truncate forward history past the current index, then push target.
        const next = navHistoryRef.current
          .slice(0, navIdxRef.current + 1)
          .concat(target);
        navHistoryRef.current = next;
        navIdxRef.current = next.length - 1;
        navigateTo(target);
      },
    });
    return () => {
      setLspContext(null);
      setHoverLinkContext(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath, cwd]);

  // Push the file's HEAD content into the editor's gutter baseline so the
  // git-diff bars decorate added/modified/deleted lines.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !activePath || !cwd || !activePath.startsWith(`${cwd}/`)) {
      return;
    }
    const rel = activePath.slice(cwd.length + 1);
    let cancelled = false;
    git
      .fileAt(cwd, "HEAD", rel)
      .then((content) => {
        if (cancelled || viewRef.current !== view) return;
        setGitBaseline(view, content);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [activePath, cwd, gitRefreshN]);

  // Reveal the active file in the tree — expand every parent dir between cwd
  // and the file, fetching contents for any not yet loaded.
  useEffect(() => {
    if (!activePath || !cwd || !activePath.startsWith(`${cwd}/`)) return;
    const rel = activePath.slice(cwd.length + 1);
    const parts = rel.split("/");
    if (parts.length < 2) return;
    const parents: string[] = [];
    let path = cwd;
    for (let i = 0; i < parts.length - 1; i++) {
      path = `${path}/${parts[i]}`;
      parents.push(path);
    }
    setExpanded((s) => {
      const n = new Set(s);
      parents.forEach((p) => n.add(p));
      return n;
    });
    for (const p of parents) {
      if (!dirs[p]) {
        void fsapi
          .readDir(p)
          .then((e) => setDirs((d) => ({ ...d, [p]: e })))
          .catch(() => {});
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath, cwd]);

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
                <IconFolder size={17} />
              </span>
              <span className="tree-name">{e.name}</span>
            </button>
            {open && renderTree(e.path, depth + 1)}
          </div>
        );
      }
      const gf = gitMap.get(e.path);
      const gd = gf ? gitDecoration(gf) : null;
      return (
        <button
          key={e.path}
          className={`tree-row file${activePath === e.path ? " active" : ""}${
            gd ? ` git-${gd.cls}` : ""
          }`}
          style={{ paddingLeft: pad + 13 }}
          onClick={() => openFile(e)}
        >
          <span className="tree-file">
            <FileIcon name={e.name} size={20} />
          </span>
          <span className="tree-name">{e.name}</span>
          {gd && <span className="tree-git">{gd.letter}</span>}
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

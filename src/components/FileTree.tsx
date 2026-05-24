import { useEffect, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { fsapi, type DirEntry } from "../api/fs";
import { type GitFile } from "../api/git";
import { useResource } from "../state/resources";
import { gitStatusR } from "../state/resources.defs";
import { IconChevron, IconFolder } from "./Icons";
import { FileIcon } from "./FileIcon";

const basename = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;

// VSCode-style decoration letter + class for a git-tracked file.
function gitDecoration(f: GitFile): { letter: string; cls: string } {
  if (f.index === "?" || f.worktree === "?") return { letter: "U", cls: "u" };
  if (f.worktree === "D" || f.index === "D") return { letter: "D", cls: "d" };
  if (f.index === "A") return { letter: "A", cls: "a" };
  if (f.index === "R" || f.worktree === "R") return { letter: "R", cls: "r" };
  if (f.worktree === "M" || f.index === "M") return { letter: "M", cls: "m" };
  return { letter: f.worktree.trim() || f.index.trim(), cls: "m" };
}

interface FileTreeProps {
  cwd: string;
  activePath: string | null;
  onOpenFile: (entry: DirEntry) => void;
  width: number;
  onResize: (w: number) => void;
  /** When the file tree should auto-reveal a path (e.g. tab switched). */
  revealPath?: string | null;
}

export function FileTree({
  cwd,
  activePath,
  onOpenFile,
  width,
  onResize,
  revealPath,
}: FileTreeProps) {
  const [dirs, setDirs] = useState<Record<string, DirEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const status = useResource(gitStatusR, cwd || "");
  const gitMap = (() => {
    const m = new Map<string, GitFile>();
    if (cwd && status.data) {
      status.data.files.forEach((f) => m.set(`${cwd}/${f.path}`, f));
    }
    return m;
  })();

  // Load root.
  useEffect(() => {
    if (!cwd) return;
    fsapi
      .readDir(cwd)
      .then((e) => setDirs((d) => ({ ...d, [cwd]: e })))
      .catch(() => {});
  }, [cwd]);

  // Reveal the active file by expanding every ancestor.
  useEffect(() => {
    const path = revealPath ?? activePath;
    if (!path || !cwd || !path.startsWith(`${cwd}/`)) return;
    const rel = path.slice(cwd.length + 1);
    const parts = rel.split("/");
    if (parts.length < 2) return;
    const parents: string[] = [];
    let p = cwd;
    for (let i = 0; i < parts.length - 1; i++) {
      p = `${p}/${parts[i]}`;
      parents.push(p);
    }
    setExpanded((s) => {
      const n = new Set(s);
      parents.forEach((x) => n.add(x));
      return n;
    });
    for (const par of parents) {
      if (!dirs[par]) {
        void fsapi
          .readDir(par)
          .then((e) => setDirs((d) => ({ ...d, [par]: e })))
          .catch(() => {});
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealPath, activePath, cwd]);

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
          onClick={() => onOpenFile(e)}
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

  const onResizeDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    let latest = startW;
    const move = (ev: PointerEvent) => {
      latest = Math.min(600, Math.max(160, startW + ev.clientX - startX));
      onResize(latest);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <>
      <div className="ed-tree" style={{ width }}>
        <div className="ed-tree-head">{basename(cwd) || "files"}</div>
        <div className="ed-tree-scroll">{renderTree(cwd, 0)}</div>
      </div>
      <div className="ed-tree-resizer" onPointerDown={onResizeDrag} title="Drag to resize" />
    </>
  );
}

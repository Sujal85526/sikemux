import { useEffect, useMemo, useRef, useState } from "react";
import { filesApi } from "../api/files";
import { useWorkspace } from "../state/workspace";
import { useMouseActive } from "../hooks/useMouseActive";
import { IconSearch } from "./Icons";
import { FileIcon } from "./FileIcon";

const MAX_RESULTS = 200;

// Subsequence fuzzy match. Returns a score (lower = better) or -1 for no
// match. Adjacent-character matches cost nothing; the score is dominated by
// the absolute position of the first match, so prefix hits float to the top.
function fuzzy(query: string, text: string): number {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let ti = 0;
  let score = 0;
  let prev = -2;
  for (let qi = 0; qi < q.length; qi++) {
    const found = t.indexOf(q[qi], ti);
    if (found === -1) return -1;
    score += found - prev === 1 ? 0 : found;
    prev = found;
    ti = found + 1;
  }
  return score;
}

const basename = (p: string) => p.split("/").pop() || p;
const dirname = (p: string) => {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
};

// Cmd-P file picker, Telescope-style. Walks the project respecting
// .gitignore on the Rust side, fuzzy-matches in JS, opens the file via the
// existing requestOpenFile bus so it lands in the editor pane.
export function FilePalette() {
  const close = useWorkspace((s) => s.closeFilePalette);
  const requestOpenFile = useWorkspace((s) => s.requestOpenFile);
  const session = useWorkspace((s) => s.sessions[s.activeSessionId]);
  const cwd = session?.cwd ?? "";

  const [query, setQuery] = useState("");
  const [all, setAll] = useState<string[]>([]);
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const mouseActive = useMouseActive();

  useEffect(() => {
    inputRef.current?.focus();
    if (!cwd) return;
    let cancelled = false;
    filesApi
      .list(cwd)
      .then((list) => {
        if (!cancelled) setAll(list);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  // Ranked + filtered results — capped at MAX_RESULTS so even huge repos
  // don't blow out the DOM.
  const items = useMemo(() => {
    const q = query.trim();
    if (!q) return all.slice(0, MAX_RESULTS);
    const ranked: { path: string; score: number; basenameScore: number }[] = [];
    for (const path of all) {
      const base = basename(path);
      // Prefer matches that hit the basename — almost always what the user
      // is reaching for. Fall back to full-path match.
      const baseScore = fuzzy(q, base);
      const fullScore = baseScore >= 0 ? baseScore : fuzzy(q, path);
      if (fullScore < 0) continue;
      ranked.push({
        path,
        score: fullScore,
        basenameScore: baseScore >= 0 ? baseScore : 999_999,
      });
    }
    ranked.sort((a, b) => {
      if (a.basenameScore !== b.basenameScore) {
        return a.basenameScore - b.basenameScore;
      }
      return a.score - b.score;
    });
    return ranked.slice(0, MAX_RESULTS).map((r) => r.path);
  }, [all, query]);

  // Reset selection to top whenever the result set changes.
  useEffect(() => {
    setSel(0);
  }, [query, items.length]);

  // Keep the selected row scrolled into view during keyboard nav.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      `.picker-item:nth-child(${sel + 1})`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const activate = (path: string | undefined) => {
    if (!path || !cwd) return;
    requestOpenFile(`${cwd}/${path}`);
    close();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      close();
    } else if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) {
      e.preventDefault();
      setSel((s) => (items.length ? (s + 1) % items.length : 0));
    } else if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) {
      e.preventDefault();
      setSel((s) => (items.length ? (s - 1 + items.length) % items.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      activate(items[sel]);
    }
  };

  return (
    <div className="picker-backdrop" onMouseDown={close}>
      <div className="picker" onMouseDown={(e) => e.stopPropagation()}>
        <div className="picker-input-wrap">
          <IconSearch size={15} className="picker-search-icon" />
          <input
            ref={inputRef}
            className="picker-input"
            placeholder={cwd ? "search files…" : "no project — open one first"}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            spellCheck={false}
            disabled={!cwd}
          />
          <span className="picker-hint">esc</span>
        </div>

        <div className="picker-list" ref={listRef}>
          {items.length === 0 && (
            <div className="picker-empty">
              {!cwd
                ? "open a project to search files"
                : all.length === 0
                  ? "indexing…"
                  : "no matches"}
            </div>
          )}
          {items.map((path, i) => {
            const name = basename(path);
            const dir = dirname(path);
            return (
              <button
                key={path}
                className={`picker-item${i === sel ? " sel" : ""}`}
                onMouseEnter={() => {
                  if (mouseActive.current) setSel(i);
                }}
                onClick={() => activate(path)}
              >
                <span className="picker-icon project">
                  <FileIcon name={name} size={14} />
                </span>
                <span className="picker-name">{name}</span>
                <span className="picker-sub">{dir || "."}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

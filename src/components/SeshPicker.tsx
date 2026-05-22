import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SessionKind } from "../state/types";
import { useWorkspace } from "../state/workspace";
import { IconCommand, IconFolder, IconSearch } from "./Icons";

type Item =
  | { kind: "session"; id: string; name: string; sub: string; sk: SessionKind }
  | { kind: "dir"; path: string; name: string; sub: string };

const basename = (p: string) =>
  p.replace(/\/+$/, "").split("/").pop() || p;

// Subsequence fuzzy match. Returns a score (lower = better) or -1 for no match.
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
    score += found - prev === 1 ? 0 : found; // reward contiguous runs
    prev = found;
    ti = found + 1;
  }
  return score;
}

export function SeshPicker() {
  const sessions = useWorkspace((s) => s.sessions);
  const home = useWorkspace((s) => s.home);
  const selectSession = useWorkspace((s) => s.selectSession);
  const createProjectSession = useWorkspace((s) => s.createProjectSession);
  const closePicker = useWorkspace((s) => s.closePicker);

  const [query, setQuery] = useState("");
  const [dirs, setDirs] = useState<string[]>([]);
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    invoke<string[]>("recent_dirs")
      .then((d) => setDirs(d.slice(0, 60)))
      .catch(() => setDirs([]));
  }, []);

  const pretty = (p: string) =>
    home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;

  const items = useMemo<Item[]>(() => {
    const open = new Set(sessions.map((s) => s.cwd).filter(Boolean));
    const sessionItems: Item[] = sessions.map((s) => ({
      kind: "session",
      id: s.id,
      name: s.name,
      sub: s.kind === "project" ? pretty(s.cwd) : "command session",
      sk: s.kind,
    }));
    const dirItems: Item[] = dirs
      .filter((d) => !open.has(d))
      .map((d) => ({ kind: "dir", path: d, name: basename(d), sub: pretty(d) }));

    const rank = (it: Item) => {
      const s = fuzzy(query, `${it.name} ${it.sub}`);
      return s;
    };
    const keep = (it: Item) => rank(it) >= 0;
    const order = (a: Item, b: Item) => rank(a) - rank(b);

    const s = sessionItems.filter(keep);
    const d = dirItems.filter(keep);
    if (query) {
      s.sort(order);
      d.sort(order);
    }
    return [...s, ...d];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, dirs, query, home]);

  useEffect(() => {
    setSel((s) => Math.min(s, Math.max(0, items.length - 1)));
  }, [items.length]);

  const activate = (it: Item | undefined) => {
    if (!it) return;
    if (it.kind === "session") selectSession(it.id);
    else createProjectSession(it.path);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      closePicker();
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

  // Index where the "project" group starts, for the group label.
  const firstDir = items.findIndex((it) => it.kind === "dir");

  return (
    <div className="picker-backdrop" onMouseDown={closePicker}>
      <div className="picker" onMouseDown={(e) => e.stopPropagation()}>
        <div className="picker-input-wrap">
          <IconSearch size={15} className="picker-search-icon" />
          <input
            ref={inputRef}
            className="picker-input"
            placeholder="jump to a session or project…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSel(0);
            }}
            onKeyDown={onKeyDown}
            spellCheck={false}
          />
          <span className="picker-hint">esc</span>
        </div>

        <div className="picker-list">
          {items.length === 0 && (
            <div className="picker-empty">no matches</div>
          )}
          {items.map((it, i) => {
            const label =
              i === 0 && it.kind === "session" ? "Open" : null;
            const dirLabel = i === firstDir && firstDir >= 0 ? "Projects" : null;
            return (
              <div key={it.kind === "session" ? it.id : it.path}>
                {label && <div className="picker-group">{label}</div>}
                {dirLabel && <div className="picker-group">{dirLabel}</div>}
                <button
                  className={`picker-item${i === sel ? " sel" : ""}`}
                  onMouseEnter={() => setSel(i)}
                  onClick={() => activate(it)}
                >
                  <span
                    className={`picker-icon ${
                      it.kind === "dir"
                        ? "project"
                        : it.sk
                    }`}
                  >
                    {it.kind === "dir" || it.sk === "project" ? (
                      <IconFolder size={14} />
                    ) : (
                      <IconCommand size={14} />
                    )}
                  </span>
                  <span className="picker-name">{it.name}</span>
                  <span className="picker-sub">{it.sub}</span>
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

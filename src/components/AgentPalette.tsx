import { useEffect, useMemo, useRef, useState } from "react";
import { agentApi, type AgentSession } from "../api/agents";
import { AGENT_TYPES, type AgentType } from "../state/types";
import { useWorkspace } from "../state/workspace";
import { useMouseActive } from "../hooks/useMouseActive";
import { AgentIcon, IconSearch } from "./Icons";

type Row = AgentSession & { type: AgentType };

function ago(unixSecs: number): string {
  if (!unixSecs) return "";
  const d = Math.max(0, Date.now() / 1000 - unixSecs);
  if (d < 90) return "now";
  if (d < 3600) return `${Math.round(d / 60)}m`;
  if (d < 86400) return `${Math.round(d / 3600)}h`;
  return `${Math.round(d / 86400)}d`;
}

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
    score += found - prev === 1 ? 0 : found;
    prev = found;
    ti = found + 1;
  }
  return score;
}

// Cross-agent session search — claude, codex and hermes in one palette.
export function AgentPalette() {
  const session = useWorkspace((s) => s.sessions[s.activeSessionId]);
  const addAgent = useWorkspace((s) => s.addAgent);
  const close = useWorkspace((s) => s.closeAgentPalette);

  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const mouseActive = useMouseActive();

  useEffect(() => {
    inputRef.current?.focus();
    const cwd = session.cwd;
    let cancelled = false;
    Promise.all(
      AGENT_TYPES.map((t) =>
        agentApi
          .sessions(t, cwd)
          .then((ss) => ss.map((s): Row => ({ ...s, type: t })))
          .catch(() => [] as Row[]),
      ),
    ).then((lists) => {
      if (!cancelled) {
        setRows(lists.flat().sort((a, b) => b.mtime - a.mtime));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [session.cwd]);

  const items = useMemo(() => {
    const q = query.trim();
    const ranked = rows
      .map((r) => ({ r, score: fuzzy(q, r.title) }))
      .filter((x) => x.score >= 0);
    if (q) ranked.sort((a, b) => a.score - b.score);
    return ranked.map((x) => x.r);
  }, [rows, query]);

  useEffect(() => {
    setSel((s) => Math.min(s, Math.max(0, items.length - 1)));
  }, [items.length]);

  const activate = (r: Row | undefined) => {
    if (!r) return;
    addAgent(r.type, r.id, r.title);
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
            placeholder="search agent sessions — claude · codex · hermes…"
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
            <div className="picker-empty">no agent sessions</div>
          )}
          {items.map((r, i) => (
            <button
              key={`${r.type}-${r.id}`}
              className={`picker-item${i === sel ? " sel" : ""}`}
              onMouseEnter={() => {
                if (mouseActive.current) setSel(i);
              }}
              onClick={() => activate(r)}
            >
              <span className={`picker-icon agent-glyph ${r.type}`}>
                <AgentIcon type={r.type} size={14} />
              </span>
              <span className="picker-name">{r.title}</span>
              <span className="picker-sub">
                {r.type} · {ago(r.mtime)}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

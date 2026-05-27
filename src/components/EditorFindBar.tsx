import { useEffect, useMemo, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";
import {
  SearchQuery,
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  setSearchQuery,
} from "@codemirror/search";

// In-editor find/replace overlay. Drives CodeMirror's search commands
// directly (no @codemirror/search panel — see EditorPane). We own the DOM
// so layout, theming, and the replace-toggle chevron all live in React
// instead of in CSS hacks against a built-in panel.

interface Props {
  /** Get the active CodeMirror view to issue commands against. Lookup is
   *  lazy so a stale ref from a re-rendered EditorPane doesn't break us. */
  getView: () => EditorView | null;
  /** Imperative open/close — EditorPane toggles this in response to the
   *  Mod-F / Mod-H keymap entries. */
  open: boolean;
  /** Open with the replace row pre-expanded. */
  replaceOpenOnMount: boolean;
  onClose: () => void;
}

export interface EditorFindBarHandle {
  focus(): void;
  /** Seed the query from the host (e.g. current editor selection). */
  setSeed(text: string): void;
}

export function EditorFindBar({ getView, open, replaceOpenOnMount, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [replace, setReplace] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regexp, setRegexp] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(replaceOpenOnMount);
  const [counts, setCounts] = useState<{ total: number; current: number }>({
    total: 0,
    current: 0,
  });

  const findInputRef = useRef<HTMLInputElement | null>(null);
  const replaceInputRef = useRef<HTMLInputElement | null>(null);

  // Track replaceOpen on every open() so re-opening with Mod-H expands.
  useEffect(() => {
    if (open && replaceOpenOnMount) setReplaceOpen(true);
  }, [open, replaceOpenOnMount]);

  // Push the current SearchQuery into CM whenever any input changes. This
  // is also what drives the highlighter — the `search()` extension reads
  // the SearchQuery effect to know what to match.
  useEffect(() => {
    const view = getView();
    if (!view) return;
    const q = new SearchQuery({
      search: query,
      replace,
      caseSensitive,
      regexp,
      wholeWord,
    });
    view.dispatch({ effects: setSearchQuery.of(q) });
    setCounts(computeCounts(view, q));
  }, [getView, query, replace, caseSensitive, regexp, wholeWord]);

  // Recompute the N-of-M counter when the doc or selection changes (the
  // user might type, move the cursor, or accept an external edit).
  useEffect(() => {
    const view = getView();
    if (!view) return;
    if (!query) {
      setCounts({ total: 0, current: 0 });
      return;
    }
    let raf = 0;
    const tick = () => {
      const q = getSearchQuery(view.state);
      if (q.search) setCounts(computeCounts(view, q));
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [getView, query, replaceOpen]);

  // Focus the find input when the bar opens.
  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => findInputRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [open]);

  const run = (fn: (view: EditorView) => boolean) => {
    const view = getView();
    if (!view) return;
    fn(view);
    // After navigating, refresh counter.
    const q = getSearchQuery(view.state);
    if (q.search) setCounts(computeCounts(view, q));
    view.focus();
  };

  const onFindKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      run(e.shiftKey ? findPrevious : findNext);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      getView()?.focus();
    }
  };

  const onReplaceKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      run(e.metaKey || e.ctrlKey ? replaceAll : replaceNext);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      getView()?.focus();
    }
  };

  const status = useMemo(() => {
    if (!query) return "";
    if (counts.total === 0) return "No results";
    return `${counts.current} of ${counts.total}`;
  }, [query, counts]);

  if (!open) return null;

  return (
    <div className={`ed-findbar${replaceOpen ? " replace" : ""}`}>
      <button
        type="button"
        className="ed-findbar-chev"
        onClick={() => {
          const next = !replaceOpen;
          setReplaceOpen(next);
          if (next) {
            window.setTimeout(() => replaceInputRef.current?.focus(), 0);
          }
        }}
        title={replaceOpen ? "Hide replace" : "Show replace"}
        aria-expanded={replaceOpen}
      >
        {replaceOpen ? "▾" : "▸"}
      </button>

      <div className="ed-findbar-rows">
        <div className="ed-findbar-row">
          <div className="ed-findbar-field">
            <input
              ref={findInputRef}
              className="ed-findbar-input"
              placeholder="Find"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onFindKeyDown}
              spellCheck={false}
            />
            <button
              type="button"
              className={`ed-findbar-toggle${caseSensitive ? " on" : ""}`}
              onClick={() => setCaseSensitive((v) => !v)}
              title="Match case (Alt+C)"
            >
              Aa
            </button>
            <button
              type="button"
              className={`ed-findbar-toggle${wholeWord ? " on" : ""}`}
              onClick={() => setWholeWord((v) => !v)}
              title="Whole word (Alt+W)"
            >
              ab
            </button>
            <button
              type="button"
              className={`ed-findbar-toggle${regexp ? " on" : ""}`}
              onClick={() => setRegexp((v) => !v)}
              title="Regex (Alt+R)"
            >
              .*
            </button>
          </div>
          <span className="ed-findbar-status">{status}</span>
          <button
            type="button"
            className="ed-findbar-btn"
            onClick={() => run(findPrevious)}
            title="Previous (Shift+Enter)"
          >
            ↑
          </button>
          <button
            type="button"
            className="ed-findbar-btn"
            onClick={() => run(findNext)}
            title="Next (Enter)"
          >
            ↓
          </button>
          <button
            type="button"
            className="ed-findbar-btn close"
            onClick={() => {
              onClose();
              getView()?.focus();
            }}
            title="Close (Esc)"
          >
            ×
          </button>
        </div>

        {replaceOpen && (
          <div className="ed-findbar-row">
            <div className="ed-findbar-field">
              <input
                ref={replaceInputRef}
                className="ed-findbar-input"
                placeholder="Replace"
                value={replace}
                onChange={(e) => setReplace(e.target.value)}
                onKeyDown={onReplaceKeyDown}
                spellCheck={false}
              />
            </div>
            <span className="ed-findbar-status" aria-hidden />
            <button
              type="button"
              className="ed-findbar-btn"
              onClick={() => run(replaceNext)}
              title="Replace (Enter)"
              disabled={!query}
            >
              ↪
            </button>
            <button
              type="button"
              className="ed-findbar-btn"
              onClick={() => run(replaceAll)}
              title="Replace all (Cmd/Ctrl+Enter)"
              disabled={!query}
            >
              ⇶
            </button>
            <span className="ed-findbar-btn-spacer" aria-hidden />
          </div>
        )}
      </div>
    </div>
  );
}

// ---- helpers ----------------------------------------------------------

function computeCounts(view: EditorView, q: SearchQuery): { total: number; current: number } {
  if (!q.valid || !q.search) return { total: 0, current: 0 };
  let total = 0;
  let current = 0;
  const sel = view.state.selection.main;
  try {
    // CM's getCursor returns an Iterator (not Iterable). Step via .next()
    // ourselves to count matches and find the one enclosing the caret.
    const cursor = q.getCursor(view.state) as {
      next(): IteratorResult<{ from: number; to: number }>;
    };
    for (;;) {
      const r = cursor.next();
      if (r.done) break;
      total++;
      if (current === 0 && r.value.from <= sel.from && sel.from <= r.value.to) {
        current = total;
      }
    }
  } catch {
    return { total: 0, current: 0 };
  }
  if (current === 0 && total > 0) current = 1;
  return { total, current };
}

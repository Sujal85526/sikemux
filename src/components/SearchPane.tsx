import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  EditorState,
  Range as CMRange,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  keymap,
  lineNumbers,
  type DecorationSet,
} from "@codemirror/view";
import { syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
import { auraExtensions, languageFor } from "../editor/codemirror";
import { registerView } from "../themes/bus";
import { fsapi } from "../api/fs";
import { subscribe } from "../state/bus";
import {
  searchApi,
  type SearchFile,
  type SearchHit,
  type SearchResults,
} from "../api/search";
import * as cmd from "../state/commands";
import { useStore } from "../state/store";
import { notify, errMessage } from "../state/toast";
import { FileIcon } from "./FileIcon";
import { IconSearch } from "./Icons";

// Project-wide search rendered as the project's 4th window. Layout:
//   ┌──────────────┬──────────────┐
//   │ glow palette │              │
//   │ (search bar) │   preview    │
//   ├──────────────┤    (wider)   │
//   │ threaded     │              │
//   │   list       │              │
//   └──────────────┴──────────────┘
// View state (query, replace, options, selected match) lives in
// `globalSearchBySession[sessionId]` so switching projects preserves each
// one's search independently.

const basename = (p: string) => p.split("/").pop() || p;
const dirname = (p: string) => {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
};

// 250ms is the sweet spot — visibly debounced but doesn't feel laggy
// for the typical 10-50ms ripgrep run.
const DEBOUNCE_MS = 250;

// Module-level stable fallback. Inline defaults inside a Zustand selector
// would return a fresh object identity each call → re-render loop. The
// `??` fallback runs OUTSIDE the selector.
const EMPTY_VIEW = {
  query: "",
  replace: "",
  replaceOpen: false,
  options: {
    caseSensitive: false,
    wholeWord: false,
    isRegex: false,
    include: "",
    exclude: "",
  },
  collapsed: {} as Record<string, boolean>,
  selected: null as { path: string; matchIndex: number } | null,
};

// =====================================================================
// Top-level pane
// =====================================================================

export function SearchPane({ cwd, active }: { cwd: string; active: boolean }) {
  const session = useStore((s) => s.sessions[s.activeSessionId]);
  const sessionId = session?.id ?? "";

  const entry = useStore((s) => s.globalSearchBySession[sessionId]);
  const view = entry ?? EMPTY_VIEW;

  const findRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);
  const [results, setResults] = useState<SearchResults | null>(null);
  const [status, setStatus] = useState<"idle" | "searching" | "ok" | "error">(
    "idle",
  );
  const [error, setError] = useState<string | null>(null);
  const [replacing, setReplacing] = useState(false);

  // Focus the find input whenever the pane becomes active.
  useEffect(() => {
    if (active) {
      findRef.current?.focus();
      findRef.current?.select();
    }
  }, [active]);

  // Pull focus back on every Cmd/Ctrl+Shift+F press, even when the pane is
  // already active (the `active` effect above only fires on transitions).
  // Scoped to this session so background panes ignore the signal.
  useEffect(() => {
    if (!sessionId) return;
    return subscribe("search-focus", (e) => {
      if (e.sessionId !== sessionId) return;
      findRef.current?.focus();
      findRef.current?.select();
    });
  }, [sessionId]);

  // Debounced search. Inflight calls drop their result if a newer one starts.
  useEffect(() => {
    if (!cwd) return;
    if (!view.query.trim()) {
      setResults(null);
      setStatus("idle");
      setError(null);
      return;
    }
    setStatus("searching");
    let cancelled = false;
    const handle = window.setTimeout(() => {
      searchApi
        .project(cwd, view.query, view.options)
        .then((r) => {
          if (cancelled) return;
          setResults(r);
          setStatus("ok");
          setError(null);
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          setStatus("error");
          setError(String(e));
        });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [cwd, view.query, view.options]);

  // Auto-select the first match whenever results refresh and either nothing
  // is selected yet, or the previously-selected file no longer appears.
  useEffect(() => {
    if (!results || results.files.length === 0) return;
    const first = results.files[0];
    const sel = view.selected;
    const stillValid =
      !!sel &&
      results.files.some(
        (f) => f.path === sel.path && sel.matchIndex < f.matches.length,
      );
    if (!stillValid) {
      cmd.setGlobalSearchSelected(sessionId, {
        path: first.path,
        matchIndex: 0,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results, sessionId]);

  const runReplaceAll = useCallback(async () => {
    if (!cwd || !view.query.trim() || replacing) return;
    setReplacing(true);
    try {
      const r = await searchApi.replace(
        cwd,
        view.query,
        view.replace,
        view.options,
      );
      const verb = r.match_count === 1 ? "match" : "matches";
      const fileWord = r.file_count === 1 ? "file" : "files";
      notify(
        r.errors.length ? "info" : "success",
        `replaced ${r.match_count} ${verb} in ${r.file_count} ${fileWord}` +
          (r.errors.length ? ` · ${r.errors.length} skipped` : ""),
      );
      const fresh = await searchApi.project(cwd, view.query, view.options);
      setResults(fresh);
      setStatus("ok");
    } catch (e) {
      notify("error", `replace failed: ${errMessage(e)}`);
    } finally {
      setReplacing(false);
    }
  }, [cwd, view.query, view.replace, view.options, replacing]);

  return (
    <div className="search-pane">
      <div className="sp-body">
        <div className="sp-left">
          <Header
            sessionId={sessionId}
            view={view}
            findRef={findRef}
            replaceRef={replaceRef}
            status={status}
            results={results}
            replacing={replacing}
            onReplaceAll={runReplaceAll}
          />
          <Threads
            sessionId={sessionId}
            cwd={cwd}
            query={view.query}
            replace={view.replace}
            selected={view.selected}
            collapsed={view.collapsed}
            results={results}
            status={status}
            error={error}
          />
        </div>
        <PreviewArea
          repo={cwd}
          query={view.query}
          replace={view.replace}
          results={results}
          status={status}
          selected={view.selected}
        />
      </div>
      <Footer />
    </div>
  );
}

// =====================================================================
// Header — flush bar (no container), accordion replace row, VSCode-style
// =====================================================================

function Header({
  sessionId,
  view,
  findRef,
  replaceRef,
  status,
  results,
  replacing,
  onReplaceAll,
}: {
  sessionId: string;
  view: typeof EMPTY_VIEW;
  findRef: React.RefObject<HTMLInputElement | null>;
  replaceRef: React.RefObject<HTMLInputElement | null>;
  status: "idle" | "searching" | "ok" | "error";
  results: SearchResults | null;
  replacing: boolean;
  onReplaceAll: () => void;
}) {
  const { query, replace, replaceOpen, options } = view;
  const hasResults = !!results && results.match_count > 0;
  const canReplace = hasResults && !replacing;
  const openReplaceAndFocus = () => {
    if (!replaceOpen) cmd.toggleGlobalSearchReplaceOpen(sessionId);
    // Defer focus so the input mounts first when we just opened it.
    window.setTimeout(() => replaceRef.current?.focus(), 0);
  };

  return (
    <div className="sp-head">
      <div className="sp-row find">
        <button
          type="button"
          className={`sp-chev${replaceOpen ? " open" : ""}`}
          onClick={() => cmd.toggleGlobalSearchReplaceOpen(sessionId)}
          title={replaceOpen ? "Hide replace" : "Show replace"}
          aria-expanded={replaceOpen}
        >
          ▸
        </button>
        <span className="sp-av find" aria-hidden>
          <IconSearch size={11} />
        </span>
        <input
          ref={findRef}
          className="sp-input"
          placeholder="find in project"
          value={query}
          onChange={(e) =>
            cmd.setGlobalSearchQuery(sessionId, e.target.value)
          }
          onKeyDown={(e) => {
            if (e.key === "Tab" && !e.shiftKey) {
              e.preventDefault();
              openReplaceAndFocus();
            }
          }}
          spellCheck={false}
        />
        {status === "searching" && (
          <span className="sp-spinner" aria-hidden />
        )}
      </div>

      {replaceOpen && (
        <div className="sp-row repl">
          <span className="sp-chev-spacer" aria-hidden />
          <span className="sp-av repl" aria-hidden>
            ↻
          </span>
          <input
            ref={replaceRef}
            className="sp-input"
            placeholder="replace with…"
            value={replace}
            onChange={(e) =>
              cmd.setGlobalSearchReplace(sessionId, e.target.value)
            }
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                if (canReplace) onReplaceAll();
              }
            }}
            spellCheck={false}
          />
        </div>
      )}

      <div className="sp-row scope">
        <FilterField
          label="in"
          placeholder="src/**/*.ts"
          value={options.include}
          onChange={(v) =>
            cmd.setGlobalSearchOption(sessionId, "include", v)
          }
        />
      </div>
      <div className="sp-row scope">
        <FilterField
          label="not"
          placeholder="**/*.test.ts"
          value={options.exclude}
          onChange={(v) =>
            cmd.setGlobalSearchOption(sessionId, "exclude", v)
          }
        />
      </div>

      <div className="sp-row actions">
        <div className="sp-toggles">
          <Toggle
            label="Aa"
            title="Match case"
            active={options.caseSensitive}
            onClick={() =>
              cmd.setGlobalSearchOption(
                sessionId,
                "caseSensitive",
                !options.caseSensitive,
              )
            }
          />
          <Toggle
            label="ab"
            title="Whole word"
            active={options.wholeWord}
            onClick={() =>
              cmd.setGlobalSearchOption(
                sessionId,
                "wholeWord",
                !options.wholeWord,
              )
            }
          />
          <Toggle
            label=".*"
            title="Regex"
            active={options.isRegex}
            onClick={() =>
              cmd.setGlobalSearchOption(
                sessionId,
                "isRegex",
                !options.isRegex,
              )
            }
          />
        </div>
        <span className="sp-stats">
          {results ? (
            <>
              <strong>{results.match_count}</strong>
              <span className="sp-stats-sep">/</span>
              <strong>{results.file_count}</strong>
              <span className="sp-stats-time">{results.elapsed_ms}ms</span>
              {results.truncated && (
                <span className="sp-truncated">trunc</span>
              )}
            </>
          ) : (
            <span className="sp-stats-dim">·</span>
          )}
        </span>
        {replaceOpen && (
          <button
            type="button"
            className="sp-replace-btn"
            onClick={onReplaceAll}
            disabled={!canReplace}
            title={
              canReplace
                ? "Replace every match across all files"
                : "Run a search first"
            }
          >
            {replacing
              ? "…"
              : `replace${
                  results && results.match_count > 0
                    ? ` ${results.match_count}`
                    : ""
                }`}
          </button>
        )}
      </div>
    </div>
  );
}

function Toggle({
  label,
  title,
  active,
  onClick,
}: {
  label: string;
  title: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`sp-toggle${active ? " on" : ""}`}
      onClick={onClick}
      title={title}
      type="button"
    >
      {label}
    </button>
  );
}

function FilterField({
  label,
  placeholder,
  value,
  onChange,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="sp-filter">
      <span className="sp-filter-label">{label}</span>
      <input
        className="sp-filter-input"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
      />
    </label>
  );
}

// =====================================================================
// Threads — the scrollable left-column results
// =====================================================================

function Threads({
  sessionId,
  cwd,
  query,
  replace,
  selected,
  collapsed,
  results,
  status,
  error,
}: {
  sessionId: string;
  cwd: string;
  query: string;
  replace: string;
  selected: typeof EMPTY_VIEW.selected;
  collapsed: Record<string, boolean>;
  results: SearchResults | null;
  status: "idle" | "searching" | "ok" | "error";
  error: string | null;
}) {
  if (!cwd) {
    return (
      <div className="sp-threads-wrap">
        <div className="sp-empty">open a project session</div>
      </div>
    );
  }
  if (status === "error") {
    return (
      <div className="sp-threads-wrap">
        <div className="sp-err">
          {error?.includes("invalid")
            ? `invalid regex: ${error}`
            : (error ?? "search failed")}
        </div>
      </div>
    );
  }
  if (!query.trim()) {
    return (
      <div className="sp-threads-wrap">
        <div className="sp-empty">
          start typing to search
          <span className="sp-empty-sub">
            tab → replace · ⌘↵ replace all
          </span>
        </div>
      </div>
    );
  }
  if (status === "searching" && !results) {
    return (
      <div className="sp-threads-wrap">
        <div className="sp-loading">searching…</div>
      </div>
    );
  }
  if (results && results.files.length === 0) {
    return (
      <div className="sp-threads-wrap">
        <div className="sp-empty">no matches</div>
      </div>
    );
  }
  if (!results) return <div className="sp-threads-wrap" />;
  return (
    <div className="sp-threads">
      {results.files.map((file) => (
        <Thread
          key={file.path}
          sessionId={sessionId}
          repo={cwd}
          file={file}
          isSelectedFile={selected?.path === file.path}
          selectedIndex={selected?.matchIndex ?? -1}
          collapsed={!!collapsed[file.path]}
          replace={replace}
        />
      ))}
    </div>
  );
}

function Thread({
  sessionId,
  repo,
  file,
  isSelectedFile,
  selectedIndex,
  collapsed,
  replace,
}: {
  sessionId: string;
  repo: string;
  file: SearchFile;
  isSelectedFile: boolean;
  selectedIndex: number;
  collapsed: boolean;
  replace: string;
}) {
  const name = basename(file.path);
  const dir = dirname(file.path);
  return (
    <div className={`sp-thread${collapsed ? " collapsed" : ""}`}>
      <button
        type="button"
        className="sp-thread-who"
        onClick={() =>
          cmd.toggleGlobalSearchFileCollapsed(sessionId, file.path)
        }
        aria-expanded={!collapsed}
        title={collapsed ? "Expand file" : "Collapse file"}
      >
        <span className={`sp-thread-chev${collapsed ? "" : " open"}`}>▸</span>
        <FileIcon name={name} size={13} />
        <span className="sp-thread-name">{name}</span>
        {dir && <span className="sp-thread-dir">{dir}/</span>}
        <span className="sp-thread-count">{file.matches.length}</span>
      </button>
      {!collapsed && (
        <div className="sp-thread-msgs">
          {file.matches.map((m, i) => (
            <button
              key={i}
              type="button"
              className={`sp-msg${
                isSelectedFile && i === selectedIndex ? " sel" : ""
              }`}
              onClick={() =>
                cmd.setGlobalSearchSelected(sessionId, {
                  path: file.path,
                  matchIndex: i,
                })
              }
              onDoubleClick={() =>
                cmd.requestOpenFile(
                  `${repo}/${file.path}`,
                  m.line - 1,
                  m.ranges[0]?.start ?? 0,
                )
              }
              title={replace ? `${m.text}  →  (with replace)` : m.text}
            >
              <span className="sp-msg-ln">{m.line}</span>
              <span className="sp-msg-tx">
                <HighlightedLine hit={m} replace={replace} />
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Render the matched line with the matched ranges marked, and (if a
 *  replacement string is present) a green inline indicator showing the
 *  new value next to the first match span. We render at most one indicator
 *  per line to keep the list scannable. */
function HighlightedLine({
  hit,
  replace,
}: {
  hit: SearchHit;
  replace: string;
}) {
  const ranges = hit.ranges;
  if (ranges.length === 0) return <>{hit.text}</>;
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  ranges.forEach((r, i) => {
    if (r.start > cursor) parts.push(hit.text.slice(cursor, r.start));
    parts.push(
      <mark key={`m${i}`}>{hit.text.slice(r.start, r.end)}</mark>,
    );
    if (replace && i === 0) {
      parts.push(
        <span key={`r${i}`} className="sp-msg-repl">
          {" → "}
          {replace}
        </span>,
      );
    }
    cursor = r.end;
  });
  if (cursor < hit.text.length) parts.push(hit.text.slice(cursor));
  return <>{parts}</>;
}

// =====================================================================
// Preview pane — wider right pane, single CodeMirror tracking `selected`
// =====================================================================

const setSelectedLineEffect = StateEffect.define<{
  line: number;
  ranges: { start: number; end: number }[];
}>();

const hitLineMark = Decoration.line({ class: "cm-sp-hit-line" });
const hitMatchMark = Decoration.mark({ class: "cm-sp-hit-match" });

function previewDecorations(
  state: EditorState,
  payload: { line: number; ranges: { start: number; end: number }[] } | null,
): DecorationSet {
  if (!payload || payload.line < 1 || payload.line > state.doc.lines) {
    return Decoration.none;
  }
  const line = state.doc.line(payload.line);
  const decos: CMRange<Decoration>[] = [];
  decos.push(hitLineMark.range(line.from));
  for (const r of payload.ranges) {
    const from = Math.min(line.from + r.start, line.to);
    const to = Math.min(line.from + r.end, line.to);
    if (to > from) decos.push(hitMatchMark.range(from, to));
  }
  return Decoration.set(decos, true);
}

function previewDecorationField() {
  return StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(value, tr) {
      let next: { line: number; ranges: { start: number; end: number }[] } | null =
        null;
      let touched = false;
      for (const e of tr.effects) {
        if (e.is(setSelectedLineEffect)) {
          next = e.value;
          touched = true;
        }
      }
      if (touched) return previewDecorations(tr.state, next);
      if (tr.docChanged) return Decoration.none;
      return value;
    },
    provide: (f) => EditorView.decorations.from(f),
  });
}

function previewDoubleClickPlugin(onOpen: () => void) {
  return ViewPlugin.define(() => ({}), {
    eventHandlers: {
      dblclick: () => {
        onOpen();
        return false;
      },
    },
  });
}

function makePreviewExtensions(path: string, onOpen: () => void) {
  const language = languageFor(path);
  return [
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    EditorView.contentAttributes.of({ tabindex: "0" }),
    auraExtensions,
    ...language,
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    lineNumbers(),
    previewDecorationField(),
    previewDoubleClickPlugin(onOpen),
    keymap.of([
      {
        key: "Enter",
        preventDefault: true,
        run: () => {
          onOpen();
          return true;
        },
      },
    ]),
    EditorView.theme({
      "&": { background: "transparent", fontSize: "12px" },
      ".cm-scroller": {
        lineHeight: "1.65",
        fontFamily: "var(--mono)",
      },
      ".cm-gutters": {
        background: "transparent",
        borderRight: "none",
        color: "var(--ink-faint)",
        paddingRight: "10px",
      },
      ".cm-lineNumbers .cm-gutterElement": {
        padding: "0 6px",
        minWidth: "38px",
        textAlign: "right",
        fontVariantNumeric: "tabular-nums",
        fontSize: "11px",
      },
      ".cm-content": { padding: "8px 0" },
      ".cm-line": { padding: "0 14px" },
      "&.cm-focused": { outline: "none" },
    }),
    EditorView.domEventHandlers({
      keydown: (e) => {
        if (e.key === "Escape") return false;
        e.stopPropagation();
        return false;
      },
    }),
  ];
}

interface PreviewState {
  doc: string | null;
  path: string | null;
  err: string | null;
}

function PreviewArea({
  repo,
  query,
  replace,
  results,
  status,
  selected,
}: {
  repo: string;
  query: string;
  replace: string;
  results: SearchResults | null;
  status: "idle" | "searching" | "ok" | "error";
  selected: typeof EMPTY_VIEW.selected;
}) {
  // Show a quiet placeholder in the preview column whenever there's nothing
  // to preview yet — keeps the split structure intact so the layout doesn't
  // jump around as the user types.
  if (!repo) {
    return (
      <div className="sp-preview">
        <div className="sp-preview-empty">no project open</div>
      </div>
    );
  }
  if (!query.trim()) {
    return (
      <div className="sp-preview">
        <div className="sp-preview-empty">preview will appear here</div>
      </div>
    );
  }
  if (status === "searching" && !results) {
    return (
      <div className="sp-preview">
        <div className="sp-preview-loading">searching…</div>
      </div>
    );
  }
  if (!results || results.files.length === 0) {
    return (
      <div className="sp-preview">
        <div className="sp-preview-empty">nothing to preview</div>
      </div>
    );
  }
  return (
    <Preview
      repo={repo}
      results={results}
      selected={selected}
      replace={replace}
    />
  );
}

function Preview({
  repo,
  results,
  selected,
  replace,
}: {
  repo: string;
  results: SearchResults;
  selected: typeof EMPTY_VIEW.selected;
  replace: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [cache, setCache] = useState<PreviewState>({
    doc: null,
    path: null,
    err: null,
  });

  // Resolve the currently-selected file + match. Falls back to the first
  // file's first match.
  const resolved = useMemo(() => {
    if (!results || results.files.length === 0) return null;
    if (selected) {
      const file = results.files.find((f) => f.path === selected.path);
      if (file && file.matches[selected.matchIndex]) {
        return { file, hit: file.matches[selected.matchIndex] };
      }
    }
    const first = results.files[0];
    return { file: first, hit: first.matches[0] };
  }, [results, selected]);

  // Load file content whenever the resolved file path changes. We cache the
  // most-recently-loaded file so flipping between matches in the same file
  // is instant; switching files triggers exactly one read_file round-trip.
  useEffect(() => {
    if (!resolved) return;
    const wantedPath = `${repo}/${resolved.file.path}`;
    let cancelled = false;
    if (cache.path === wantedPath && cache.doc != null) return;
    fsapi
      .readFile(wantedPath)
      .then((doc) => {
        if (cancelled) return;
        setCache({ doc, path: wantedPath, err: null });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setCache({ doc: null, path: wantedPath, err: errMessage(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [repo, resolved, cache.path, cache.doc]);

  // (Re)build the editor whenever the loaded file changes.
  useEffect(() => {
    if (!hostRef.current) return;
    if (!resolved || cache.doc == null || cache.path == null) return;
    if (cache.path !== `${repo}/${resolved.file.path}`) return;

    const exts = makePreviewExtensions(resolved.file.path, () => {
      const hit = resolved.hit;
      if (!hit) return;
      cmd.requestOpenFile(
        `${repo}/${resolved.file.path}`,
        hit.line - 1,
        hit.ranges[0]?.start ?? 0,
      );
    });
    const state = EditorState.create({ doc: cache.doc, extensions: exts });
    const view = new EditorView({ parent: hostRef.current, state });
    viewRef.current = view;
    const unreg = registerView(view);

    return () => {
      unreg();
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cache.doc, cache.path, repo]);

  // Push the selected line's highlights into the existing editor and
  // scroll it into view.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !resolved) return;
    const hit = resolved.hit;
    if (!hit) return;
    const lineNo = hit.line;
    if (lineNo < 1 || lineNo > view.state.doc.lines) return;
    const line = view.state.doc.line(lineNo);
    view.dispatch({
      effects: [
        setSelectedLineEffect.of({ line: lineNo, ranges: hit.ranges }),
        EditorView.scrollIntoView(line.from, { y: "center" }),
      ],
    });
  }, [resolved, cache.doc]);

  if (!resolved) {
    return (
      <div className="sp-preview">
        <div className="sp-preview-empty">no match selected</div>
      </div>
    );
  }

  const { file, hit } = resolved;
  const total = file.matches.length;
  const currentIndex = file.matches.findIndex((m) => m === hit) + 1;

  return (
    <div className="sp-preview">
      <button
        type="button"
        className="sp-preview-head"
        onClick={() =>
          cmd.requestOpenFile(
            `${repo}/${file.path}`,
            hit.line - 1,
            hit.ranges[0]?.start ?? 0,
          )
        }
        title={`Open ${file.path} at line ${hit.line}`}
      >
        <FileIcon name={basename(file.path)} size={13} />
        <span className="sp-preview-name">{basename(file.path)}</span>
        <span className="sp-preview-dir">{dirname(file.path)}/</span>
        <span className="sp-preview-meta">
          line {hit.line} · {currentIndex} of {total}
          {replace && (
            <span className="sp-preview-repl"> → {replace}</span>
          )}
        </span>
        <span className="sp-preview-open" aria-hidden>
          ↗
        </span>
      </button>
      {cache.err ? (
        <div className="sp-preview-err">
          could not load {file.path}: {cache.err}
        </div>
      ) : cache.doc == null ? (
        <div className="sp-preview-loading">loading…</div>
      ) : (
        <div className="sp-preview-host" ref={hostRef} />
      )}
    </div>
  );
}

// =====================================================================
// Footer — keyboard hints
// =====================================================================

function Footer() {
  return (
    <div className="sp-foot">
      <span>
        <kbd>↵</kbd> open
      </span>
      <span>
        <kbd>tab</kbd> replace
      </span>
      <span>
        <kbd>⌘↵</kbd> replace all
      </span>
      <span>
        <kbd>⌘⇧F</kbd> focus
      </span>
    </div>
  );
}

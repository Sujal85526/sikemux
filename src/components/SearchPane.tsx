import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  EditorState,
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
import {
  searchApi,
  type SearchFile,
  type SearchResults,
} from "../api/search";
import * as cmd from "../state/commands";
import { useStore } from "../state/store";
import { FileIcon } from "./FileIcon";
import { IconChevron, IconSearch } from "./Icons";

// Project-wide search rendered as the project's 4th window (a dedicated
// pane, not a modal). Built around `searchApi.project` (ripgrep on the
// Rust side, capped + streamed in <50ms for typical repos) and per-file
// mini CodeMirror views for real syntax highlighting in each snippet.
//
// View state (query, options, collapsed file groups) lives in
// `globalSearchBySession[sessionId]` so switching between project
// sessions preserves each one's search independently.

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
  options: {
    caseSensitive: false,
    wholeWord: false,
    isRegex: false,
    include: "",
    exclude: "",
  },
  collapsed: {} as Record<string, boolean>,
};

interface SnippetIndex {
  /** Map from in-snippet line (1-based) → original file line (1-based). */
  originalLine: Map<number, number>;
}

// =====================================================================
// Top-level pane
// =====================================================================

export function SearchPane({ cwd, active }: { cwd: string; active: boolean }) {
  const session = useStore((s) => s.sessions[s.activeSessionId]);
  const sessionId = session?.id ?? "";

  const entry = useStore((s) => s.globalSearchBySession[sessionId]);
  const view = entry ?? EMPTY_VIEW;

  const inputRef = useRef<HTMLInputElement>(null);
  const [results, setResults] = useState<SearchResults | null>(null);
  const [status, setStatus] = useState<"idle" | "searching" | "ok" | "error">(
    "idle",
  );
  const [error, setError] = useState<string | null>(null);

  // Focus the search input whenever the pane becomes active. Re-running
  // when `active` flips covers the M-i/r/g window switch case where the
  // user lands here from elsewhere.
  useEffect(() => {
    if (active) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [active]);

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

  return (
    <div className="search-pane">
      <Header
        sessionId={sessionId}
        view={view}
        inputRef={inputRef}
        status={status}
        results={results}
      />
      <Body
        sessionId={sessionId}
        cwd={cwd}
        query={view.query}
        options={view.options}
        collapsed={view.collapsed}
        results={results}
        status={status}
        error={error}
      />
      <Footer />
    </div>
  );
}

// =====================================================================
// Header — query + options + summary
// =====================================================================

function Header({
  sessionId,
  view,
  inputRef,
  status,
  results,
}: {
  sessionId: string;
  view: typeof EMPTY_VIEW;
  inputRef: React.RefObject<HTMLInputElement | null>;
  status: "idle" | "searching" | "ok" | "error";
  results: SearchResults | null;
}) {
  const { query, options } = view;
  const allCollapsed =
    !!results && results.files.length > 0 &&
    results.files.every((f) => view.collapsed[f.path]);
  return (
    <div className="search-head">
      <div className="search-title-row">
        <span className="search-title">
          <IconSearch size={12} className="search-title-icon" />
          <span>search</span>
        </span>
        {results && (
          <span className="search-summary">
            <strong>{results.match_count}</strong>{" "}
            {results.match_count === 1 ? "match" : "matches"} ·{" "}
            <strong>{results.file_count}</strong>{" "}
            {results.file_count === 1 ? "file" : "files"} ·{" "}
            {results.elapsed_ms}ms
            {results.truncated && (
              <span className="search-truncated"> · truncated</span>
            )}
          </span>
        )}
        {results && results.file_count > 0 && (
          <button
            className="search-fold-all"
            onClick={() =>
              allCollapsed
                ? cmd.expandAllGlobalSearchFiles(sessionId)
                : cmd.collapseAllGlobalSearchFiles(
                    sessionId,
                    results.files.map((f) => f.path),
                  )
            }
            title={allCollapsed ? "Expand all" : "Collapse all"}
          >
            {allCollapsed ? "expand all" : "collapse all"}
          </button>
        )}
      </div>

      <div className="search-input-row">
        <span className="search-input-wrap">
          <IconSearch size={13} className="search-input-icon" />
          <input
            ref={inputRef}
            className="search-input"
            placeholder="search project…"
            value={query}
            onChange={(e) =>
              cmd.setGlobalSearchQuery(sessionId, e.target.value)
            }
            spellCheck={false}
          />
          {status === "searching" && (
            <span className="search-spinner" aria-hidden />
          )}
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
        </span>
      </div>

      <div className="search-filters">
        <FilterField
          label="include"
          placeholder="src/**/*.ts"
          value={options.include}
          onChange={(v) =>
            cmd.setGlobalSearchOption(sessionId, "include", v)
          }
        />
        <FilterField
          label="exclude"
          placeholder="**/*.test.ts"
          value={options.exclude}
          onChange={(v) =>
            cmd.setGlobalSearchOption(sessionId, "exclude", v)
          }
        />
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
      className={`search-toggle${active ? " on" : ""}`}
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
    <label className="search-filter">
      <span className="search-filter-label">{label}</span>
      <input
        className="search-filter-input"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
      />
    </label>
  );
}

// =====================================================================
// Body — file groups
// =====================================================================

function Body({
  sessionId,
  cwd,
  query,
  options,
  collapsed,
  results,
  status,
  error,
}: {
  sessionId: string;
  cwd: string;
  query: string;
  options: typeof EMPTY_VIEW.options;
  collapsed: Record<string, boolean>;
  results: SearchResults | null;
  status: "idle" | "searching" | "ok" | "error";
  error: string | null;
}) {
  if (!cwd) {
    return (
      <div className="search-body">
        <div className="search-empty">
          open a project session to search its files
        </div>
      </div>
    );
  }
  if (status === "error") {
    return (
      <div className="search-body">
        <div className="search-err">
          {error?.includes("invalid")
            ? `invalid regex: ${error}`
            : (error ?? "search failed")}
        </div>
      </div>
    );
  }
  if (!query.trim()) {
    return (
      <div className="search-body">
        <div className="search-empty">
          start typing to search the project · respects the Cmd-P exclusions
        </div>
      </div>
    );
  }
  if (status === "searching" && !results) {
    return (
      <div className="search-body">
        <div className="search-loading">searching…</div>
      </div>
    );
  }
  if (results && results.files.length === 0) {
    return (
      <div className="search-body">
        <div className="search-empty">no matches</div>
      </div>
    );
  }
  return (
    <div className="search-body">
      {results?.files.map((f) => (
        <FileGroup
          key={f.path}
          sessionId={sessionId}
          repo={cwd}
          file={f}
          options={options}
          collapsed={!!collapsed[f.path]}
        />
      ))}
    </div>
  );
}

function FileGroup({
  sessionId,
  repo,
  file,
  options,
  collapsed,
}: {
  sessionId: string;
  repo: string;
  file: SearchFile;
  options: typeof EMPTY_VIEW.options;
  collapsed: boolean;
}) {
  const name = basename(file.path);
  const dir = dirname(file.path);
  return (
    <div className={`search-file${collapsed ? " collapsed" : ""}`}>
      <button
        className="search-file-head"
        onClick={() =>
          cmd.toggleGlobalSearchFileCollapsed(sessionId, file.path)
        }
      >
        <span className={`search-chev${collapsed ? "" : " open"}`}>
          <IconChevron size={10} />
        </span>
        <FileIcon name={name} size={14} />
        <span className="search-file-name">{name}</span>
        {dir && <span className="search-file-dir">{dir}</span>}
        <span className="search-file-count">{file.matches.length}</span>
      </button>
      {!collapsed && (
        <Snippet repo={repo} file={file} options={options} />
      )}
    </div>
  );
}

// =====================================================================
// Snippet — a mini CodeMirror view with the matched lines + highlighting
// =====================================================================

const matchMark = Decoration.mark({ class: "cm-search-match" });
const matchLineMark = Decoration.line({ class: "cm-search-line" });

interface SnippetMatch {
  /** snippet line, 1-based */
  line: number;
  ranges: { start: number; end: number }[];
}

function buildSnippet(file: SearchFile): {
  doc: string;
  index: SnippetIndex;
  marks: SnippetMatch[];
} {
  const lines: string[] = [];
  const originalLine = new Map<number, number>();
  const marks: SnippetMatch[] = [];
  file.matches.forEach((m, i) => {
    const snippetLine = i + 1;
    lines.push(m.text);
    originalLine.set(snippetLine, m.line);
    marks.push({ line: snippetLine, ranges: m.ranges });
  });
  return {
    doc: lines.join("\n"),
    index: { originalLine },
    marks,
  };
}

function decorationsFor(state: EditorState, marks: SnippetMatch[]): DecorationSet {
  const markRanges: { from: number; to: number; deco: ReturnType<typeof Decoration.mark> }[] = [];
  const lineDecos: { pos: number; deco: ReturnType<typeof Decoration.line> }[] = [];
  for (const m of marks) {
    if (m.line < 1 || m.line > state.doc.lines) continue;
    const line = state.doc.line(m.line);
    lineDecos.push({ pos: line.from, deco: matchLineMark });
    for (const r of m.ranges) {
      const from = Math.min(line.from + r.start, line.to);
      const to = Math.min(line.from + r.end, line.to);
      if (to > from) markRanges.push({ from, to, deco: matchMark });
    }
  }
  const all = [
    ...lineDecos.map((l) => l.deco.range(l.pos)),
    ...markRanges.map((b) => b.deco.range(b.from, b.to)),
  ];
  // `Decoration.set(..., sort=true)` handles the (from, startSide) ordering
  // line decorations need to interleave properly with mark decorations.
  return Decoration.set(all, true);
}

const setMarksEffect = StateEffect.define<SnippetMatch[]>();

function snippetDecorationField(initial: SnippetMatch[]) {
  return StateField.define<DecorationSet>({
    create: (state) => decorationsFor(state, initial),
    update(value, tr) {
      let marks: SnippetMatch[] | null = null;
      for (const e of tr.effects) {
        if (e.is(setMarksEffect)) marks = e.value;
      }
      if (marks !== null || tr.docChanged) {
        return decorationsFor(tr.state, marks ?? initial);
      }
      return value;
    },
    provide: (f) => EditorView.decorations.from(f),
  });
}

function clickToOpenPlugin(onOpen: (snippetLine: number) => void) {
  return ViewPlugin.define(() => ({}), {
    eventHandlers: {
      click: (e, view) => {
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
        if (pos == null) return false;
        const lineObj = view.state.doc.lineAt(pos);
        onOpen(lineObj.number);
        return false;
      },
    },
  });
}

function makeSnippetExtensions(
  path: string,
  marks: SnippetMatch[],
  onOpen: (snippetLine: number) => void,
) {
  const language = languageFor(path);
  return [
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    EditorView.contentAttributes.of({ tabindex: "0" }),
    auraExtensions,
    ...language,
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    lineNumbers({
      formatNumber: (n) => {
        const m = marks[n - 1];
        return m ? String(m.line) : "";
      },
    }),
    snippetDecorationField(marks),
    clickToOpenPlugin(onOpen),
    keymap.of([
      {
        key: "Alt-Enter",
        preventDefault: true,
        run: (view) => {
          const line = view.state.doc.lineAt(
            view.state.selection.main.head,
          ).number;
          onOpen(line);
          return true;
        },
      },
      {
        key: "Enter",
        preventDefault: true,
        run: (view) => {
          const line = view.state.doc.lineAt(
            view.state.selection.main.head,
          ).number;
          onOpen(line);
          return true;
        },
      },
    ]),
    EditorView.theme({
      "&": {
        background: "transparent",
        fontSize: "12px",
      },
      ".cm-scroller": {
        lineHeight: "1.55",
        fontFamily: "var(--mono)",
      },
      ".cm-gutters": {
        background: "transparent",
        borderRight: "none",
        color: "var(--ink-faint)",
        paddingRight: "10px",
      },
      ".cm-lineNumbers .cm-gutterElement": {
        padding: "0 4px",
        minWidth: "32px",
        textAlign: "right",
        fontVariantNumeric: "tabular-nums",
        fontSize: "11px",
      },
      ".cm-content": { padding: "4px 0" },
      ".cm-line": { padding: "0 12px" },
      "&.cm-focused": { outline: "none" },
    }),
    EditorView.domEventHandlers({
      keydown: (e) => {
        // Allow Esc to bubble up to the project shortcuts; swallow other
        // keys so typing in the snippet doesn't trigger window shortcuts.
        if (e.key === "Escape") return false;
        e.stopPropagation();
        return false;
      },
    }),
  ];
}

function Snippet({
  repo,
  file,
  options,
}: {
  repo: string;
  file: SearchFile;
  options: typeof EMPTY_VIEW.options;
}) {
  void options;
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const built = useMemo(() => buildSnippet(file), [file]);

  const indexRef = useRef(built.index);
  indexRef.current = built.index;

  const openAt = useCallback(
    (snippetLine: number) => {
      const original = indexRef.current.originalLine.get(snippetLine);
      if (original == null) return;
      cmd.requestOpenFile(`${repo}/${file.path}`, original - 1, 0);
    },
    [repo, file.path],
  );

  useEffect(() => {
    if (!hostRef.current) return;
    const exts = makeSnippetExtensions(file.path, built.marks, (line) =>
      openAt(line),
    );
    const state = EditorState.create({
      doc: built.doc,
      extensions: exts,
    });
    const view = new EditorView({ parent: hostRef.current, state });
    viewRef.current = view;
    const unreg = registerView(view);
    return () => {
      unreg();
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.path]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: built.doc },
      effects: setMarksEffect.of(built.marks),
    });
  }, [built.doc, built.marks]);

  return <div className="search-snippet" ref={hostRef} />;
}

// =====================================================================
// Footer — keyboard hints
// =====================================================================

function Footer() {
  return (
    <div className="search-foot">
      <span>
        <kbd>↵</kbd> open at cursor
      </span>
      <span>
        <kbd>⌥↵</kbd> open at cursor
      </span>
      <span>
        <kbd>⌘⇧F</kbd> focus search
      </span>
    </div>
  );
}

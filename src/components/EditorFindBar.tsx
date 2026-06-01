import { useEffect, useMemo, useRef, useState } from "react";
import { EditorView } from "@codemirror/view";
import { SearchQuery, findNext, findPrevious, getSearchQuery, replaceAll, replaceNext, setSearchQuery } from "@codemirror/search";
import { IconSearch } from "./Icons";

interface Props {
    getView: () => EditorView | null;
    open: boolean;
    replaceOpenOnMount: boolean;
    seed: string | null;
    signal: number;
    onClose: () => void;
}

export function EditorFindBar({ getView, open, replaceOpenOnMount, seed, signal, onClose }: Props) {
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

    useEffect(() => {
        if (open && replaceOpenOnMount) setReplaceOpen(true);
    }, [open, replaceOpenOnMount]);

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

    useEffect(() => {
        if (!open) return;
        if (seed && seed.length > 0) setQuery(seed);
        const t = window.setTimeout(() => {
            findInputRef.current?.focus();
            findInputRef.current?.select();
        }, 0);
        return () => window.clearTimeout(t);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, signal]);

    const run = (fn: (view: EditorView) => boolean, center = true) => {
        const view = getView();
        if (!view) return;
        fn(view);
        if (center) {
            const sel = view.state.selection.main;
            view.dispatch({
                effects: EditorView.scrollIntoView(sel.from, { y: "center" }),
            });
        }
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
                aria-expanded={replaceOpen}>
                {replaceOpen ? "▾" : "▸"}
            </button>

            <div className="ed-findbar-rows">
                <div className="ed-findbar-row">
                    <span className="ed-findbar-av find" aria-hidden>
                        <IconSearch size={11} />
                    </span>
                    <input
                        ref={findInputRef}
                        className="ed-findbar-input"
                        placeholder="Find"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        onKeyDown={onFindKeyDown}
                        spellCheck={false}
                    />
                    <div className="ed-findbar-toggles">
                        <button
                            type="button"
                            className={`ed-findbar-toggle${caseSensitive ? " on" : ""}`}
                            onClick={() => setCaseSensitive((v) => !v)}
                            title="Match case (Alt+C)">
                            Aa
                        </button>
                        <button
                            type="button"
                            className={`ed-findbar-toggle${wholeWord ? " on" : ""}`}
                            onClick={() => setWholeWord((v) => !v)}
                            title="Whole word (Alt+W)">
                            ab
                        </button>
                        <button
                            type="button"
                            className={`ed-findbar-toggle${regexp ? " on" : ""}`}
                            onClick={() => setRegexp((v) => !v)}
                            title="Regex (Alt+R)">
                            .*
                        </button>
                    </div>
                    <span className="ed-findbar-status">{status}</span>
                    <button type="button" className="ed-findbar-btn" onClick={() => run(findPrevious)} title="Previous (Shift+Enter)">
                        ↑
                    </button>
                    <button type="button" className="ed-findbar-btn" onClick={() => run(findNext)} title="Next (Enter)">
                        ↓
                    </button>
                    <button
                        type="button"
                        className="ed-findbar-btn close"
                        onClick={() => {
                            onClose();
                            getView()?.focus();
                        }}
                        title="Close (Esc)">
                        ×
                    </button>
                </div>

                {replaceOpen && (
                    <div className="ed-findbar-row">
                        <span className="ed-findbar-av repl" aria-hidden>
                            ↻
                        </span>
                        <input
                            ref={replaceInputRef}
                            className="ed-findbar-input"
                            placeholder="Replace"
                            value={replace}
                            onChange={(e) => setReplace(e.target.value)}
                            onKeyDown={onReplaceKeyDown}
                            spellCheck={false}
                        />
                        <span className="ed-findbar-status" aria-hidden />
                        <button type="button" className="ed-findbar-btn" onClick={() => run(replaceNext)} title="Replace (Enter)" disabled={!query}>
                            ↪
                        </button>
                        <button
                            type="button"
                            className="ed-findbar-btn"
                            onClick={() => run(replaceAll)}
                            title="Replace all (Cmd/Ctrl+Enter)"
                            disabled={!query}>
                            ⇶
                        </button>
                        <span className="ed-findbar-btn-spacer" aria-hidden />
                    </div>
                )}
            </div>
        </div>
    );
}

function computeCounts(view: EditorView, q: SearchQuery): { total: number; current: number } {
    if (!q.valid || !q.search) return { total: 0, current: 0 };
    let total = 0;
    let current = 0;
    const sel = view.state.selection.main;
    try {
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

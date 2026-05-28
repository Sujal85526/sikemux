import { useEffect, useMemo, useRef, useState } from "react";
import { agentApi, type AgentSession } from "../api/agents";
import { AGENT_TYPES, type AgentType } from "../state/types";
import * as cmd from "../state/commands";
import { useStore } from "../state/store";
import { useMouseActive } from "../hooks/useMouseActive";
import { AgentIcon, IconSearch } from "./Icons";

type Row = AgentSession & { type: AgentType };
type NewAgentItem = { kind: "new"; type: AgentType };
type ResumeAgentItem = { kind: "resume"; row: Row };
type AgentItem = NewAgentItem | ResumeAgentItem;

const labelForType = (type: AgentType): string => type;

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
// Stays imperative — three parallel scans per cwd is small enough that
// promoting it to a resource definition would just add ceremony.
export function AgentPalette() {
    const session = useStore((s) => s.sessions[s.activeSessionId]);

    const [query, setQuery] = useState("");
    const [rows, setRows] = useState<Row[]>([]);
    const [sel, setSel] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);
    const mouseActive = useMouseActive();

    useEffect(() => {
        inputRef.current?.focus();
        const cwd = session?.cwd ?? "";
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
    }, [session?.cwd]);

    const items = useMemo(() => {
        const q = query.trim();
        const fresh = AGENT_TYPES.map((type): AgentItem => ({ kind: "new", type }));
        const resumable = rows.map((row): AgentItem => ({ kind: "resume", row }));
        const all = [...fresh, ...resumable];
        const ranked = all
            .map((item) => ({
                item,
                score: fuzzy(
                    q,
                    item.kind === "new" ? `new ${labelForType(item.type)} ${item.type}` : `${item.row.title} ${item.row.type}`,
                ),
            }))
            .filter((x) => x.score >= 0);
        if (q) ranked.sort((a, b) => a.score - b.score);
        return ranked.map((x) => x.item);
    }, [rows, query]);

    useEffect(() => {
        setSel((s) => Math.min(s, Math.max(0, items.length - 1)));
    }, [items.length]);

    const activate = (item: AgentItem | undefined) => {
        if (!item) return;
        if (item.kind === "new") {
            cmd.addAgent(item.type);
        } else {
            cmd.addAgent(item.row.type, item.row.id, item.row.title);
        }
        cmd.closeAgentPalette();
    };

    const onKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "Escape") {
            cmd.closeAgentPalette();
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
        <div className="picker-backdrop" onMouseDown={cmd.closeAgentPalette}>
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
                    {items.length === 0 && <div className="picker-empty">no agent matches</div>}
                    {items.map((item, i) => {
                        const type = item.kind === "new" ? item.type : item.row.type;
                        return (
                            <button
                                key={item.kind === "new" ? `new-${type}` : `${type}-${item.row.id}`}
                                className={`picker-item${i === sel ? " sel" : ""}`}
                                onMouseEnter={() => {
                                    if (mouseActive.current) setSel(i);
                                }}
                                onClick={() => activate(item)}>
                                <span className={`picker-icon agent-glyph ${type}`}>
                                    <AgentIcon type={type} size={14} />
                                </span>
                                <span className="picker-name">
                                    {item.kind === "new" ? `new ${labelForType(type)}` : item.row.title}
                                </span>
                                <span className="picker-sub">
                                    {item.kind === "new" ? "start agent" : `${type} · ${ago(item.row.mtime)}`}
                                </span>
                            </button>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}

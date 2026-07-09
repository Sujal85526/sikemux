import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { agentApi, type AgentInfo, type AgentSession } from "../api/agents";
import { rankBy } from "../lib/fuzzy";
import { useResource } from "../state/resources";
import { agentCatalogR } from "../state/resources.defs";
import { type AgentType } from "../state/types";
import * as cmd from "../state/commands";
import { useStore } from "../state/store";
import { useMouseActive } from "../hooks/useMouseActive";
import { AgentIcon, IconSearch } from "./Icons";

type Row = AgentSession & { type: AgentType };
type NewAgentItem = { kind: "new"; type: AgentType };
type ResumeAgentItem = { kind: "resume"; row: Row };
type AgentItem = NewAgentItem | ResumeAgentItem;

function labelForType(type: AgentType, agents: AgentInfo[]): string {
    return agents.find((a) => a.type === type)?.label ?? type;
}

function ago(unixSecs: number): string {
    if (!unixSecs) return "";
    const d = Math.max(0, Date.now() / 1000 - unixSecs);
    if (d < 90) return "now";
    if (d < 3600) return `${Math.round(d / 60)}m`;
    if (d < 86400) return `${Math.round(d / 3600)}h`;
    return `${Math.round(d / 86400)}d`;
}

export function AgentPalette() {
    const session = useStore((s) => s.sessions[s.activeSessionId]);
    const catalog = useResource(agentCatalogR);
    const agents = useMemo(() => catalog.data ?? [], [catalog.data]);

    const [query, setQuery] = useState("");
    const [rows, setRows] = useState<Row[]>([]);
    const [sel, setSel] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);
    const mouseActive = useMouseActive();

    useEffect(() => {
        inputRef.current?.focus();
        const cwd = session?.cwd ?? "";
        let cancelled = false;
        if (agents.length === 0) {
            setRows([]);
            return () => {
                cancelled = true;
            };
        }
        Promise.all(
            agents.map((a) =>
                agentApi
                    .sessions(a.type, cwd)
                    .then((ss) => ss.map((s): Row => ({ ...s, type: a.type })))
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
    }, [agents, session?.cwd]);

    const items = useMemo(() => {
        const fresh = agents.map(({ type }): NewAgentItem => ({ kind: "new", type }));
        const resumable = rows.map((row): ResumeAgentItem => ({ kind: "resume", row }));
        const rankedFresh = rankBy(query, fresh, (item) => `+ new ${labelForType(item.type, agents)} ${item.type}`);
        const rankedResumable = rankBy(query, resumable, (item) => `${item.row.title} ${labelForType(item.row.type, agents)} ${item.row.type}`);
        return [...rankedFresh, ...rankedResumable];
    }, [agents, rows, query]);

    const firstResumeIndex = items.findIndex((item) => item.kind === "resume");

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
            <div className="picker agent-palette" onMouseDown={(e) => e.stopPropagation()}>
                <div className="picker-input-wrap">
                    <IconSearch size={15} className="picker-search-icon" />
                    <input
                        ref={inputRef}
                        className="picker-input"
                        placeholder={
                            agents.length
                                ? `search agent sessions — ${agents.map((a) => a.label).join(" · ")}...`
                                : catalog.status === "loading"
                                  ? "detecting agent CLIs..."
                                  : "no agent CLIs detected"
                        }
                        value={query}
                        onChange={(e) => {
                            setQuery(e.target.value);
                            setSel(0);
                        }}
                        onKeyDown={onKeyDown}
                        spellCheck={false}
                    />
                    <span className="picker-hints">
                        <span className="picker-hint">↑↓ nav</span>
                        <span className="picker-hint">⏎ open</span>
                        <span className="picker-hint">esc</span>
                    </span>
                </div>

                <div className="picker-list">
                    {items.length === 0 && <div className="picker-empty">no agent matches</div>}
                    {items.map((item, i) => {
                        const type = item.kind === "new" ? item.type : item.row.type;
                        const key = item.kind === "new" ? `new-${type}` : `${type}-${item.row.id}`;
                        return (
                            <Fragment key={key}>
                                {i === firstResumeIndex && firstResumeIndex > 0 && <div className="agent-palette-divider" />}
                                <button
                                    className={`picker-item${i === sel ? " sel" : ""}`}
                                    onMouseEnter={() => {
                                        if (mouseActive.current) setSel(i);
                                    }}
                                    onClick={() => activate(item)}>
                                    <span className={`picker-icon agent-glyph ${type}`}>
                                        <AgentIcon type={type} size={14} />
                                    </span>
                                    <span className="picker-name">
                                        {item.kind === "new" ? `+ new ${labelForType(type, agents)}` : item.row.title}
                                    </span>
                                    <span className="picker-sub">
                                        {item.kind === "new" ? "start agent" : `${labelForType(type, agents)} · ${ago(item.row.mtime)}`}
                                    </span>
                                </button>
                            </Fragment>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}

import { useEffect, useMemo, useRef, useState } from "react";
import { type MatrixCell, type RundeckEnvSpec } from "../../api/rundeck";
import { useMouseActive } from "../../hooks/useMouseActive";
import * as cmd from "../../state/commands";
import { useResourceEnabled } from "../../state/resources";
import { rndMatrixR } from "../../state/resources.defs";
import { envFolderOf, inferEnv } from "../../state/rundeckShape";
import { useStore } from "../../state/store";
import { IconCommand, IconSearch } from "../Icons";

const MAX_RESULTS = 160;

function fuzzy(query: string, text: string): number {
    if (!query) return 0;
    const q = query.toLowerCase();
    const t = text.toLowerCase();
    let ti = 0;
    let score = 0;
    let prev = -2;
    for (let qi = 0; qi < q.length; qi += 1) {
        const found = t.indexOf(q[qi], ti);
        if (found === -1) return -1;
        score += found - prev === 1 ? 0 : found;
        prev = found;
        ti = found + 1;
    }
    return score;
}

export function RundeckJobPalette() {
    const project = useStore((s) => s.rundeck.activeProject);
    const envFolder = useStore((s) => s.rundeck.activeEnvFolder);
    const paneId = useStore((s) => {
        const sess = s.sessions[s.activeSessionId];
        if (!sess || sess.kind !== "rundeck" || sess.view !== "windows") return null;
        return s.windows[sess.activeWindowId]?.activePaneId ?? null;
    });

    const [query, setQuery] = useState("");
    const [sel, setSel] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const mouseActive = useMouseActive();

    const specs = useMemo<RundeckEnvSpec[]>(
        () => (project ? [{ label: project, project, only_succeeded: true }] : []),
        [project],
    );
    const res = useResourceEnabled(!!project, rndMatrixR, specs);

    useEffect(() => {
        inputRef.current?.focus();
    }, []);

    const all = useMemo(() => {
        const cells = res.data?.envs[0]?.cells ?? [];
        return cells
            .filter((c) => !envFolder || envFolderOf(c.group) === envFolder)
            .sort((a, b) => a.service.localeCompare(b.service));
    }, [res.data, envFolder]);

    const items = useMemo(() => {
        const q = query.trim();
        const ranked = all
            .map((cell) => {
                const serviceScore = fuzzy(q, cell.service);
                const nameScore = fuzzy(q, cell.name);
                const fullScore = Math.min(serviceScore >= 0 ? serviceScore : 999_999, nameScore >= 0 ? nameScore : 999_999);
                const fallbackScore = fullScore < 999_999 ? fullScore : fuzzy(q, jobSearchText(cell));
                return { cell, score: fallbackScore, nameScore: nameScore >= 0 ? nameScore : 999_999 };
            })
            .filter((x) => x.score >= 0);
        if (q) {
            ranked.sort((a, b) => {
                if (a.nameScore !== b.nameScore) return a.nameScore - b.nameScore;
                return a.score - b.score;
            });
        }
        return ranked.slice(0, MAX_RESULTS).map((x) => x.cell);
    }, [all, query]);

    useEffect(() => {
        setSel((s) => Math.min(s, Math.max(0, items.length - 1)));
    }, [items.length]);

    useEffect(() => {
        const el = listRef.current?.querySelector<HTMLElement>(`.picker-item:nth-child(${sel + 1})`);
        el?.scrollIntoView({ block: "nearest" });
    }, [sel]);

    const activate = (cell: MatrixCell | undefined) => {
        if (!cell || !paneId || !project) return;
        cmd.rundeckPush(paneId, {
            kind: "service",
            env: inferEnv(project, cell.group),
            project,
            service: cell.service,
            jobId: cell.job_id,
        });
        cmd.closeRundeckJobPalette();
    };

    const onKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "Escape") {
            cmd.closeRundeckJobPalette();
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
        <div className="picker-backdrop" onMouseDown={cmd.closeRundeckJobPalette}>
            <div className="picker" onMouseDown={(e) => e.stopPropagation()}>
                <div className="picker-input-wrap">
                    <IconSearch size={15} className="picker-search-icon" />
                    <input
                        ref={inputRef}
                        className="picker-input"
                        placeholder={project ? "search Rundeck jobs..." : "pick a Rundeck project first"}
                        value={query}
                        onChange={(e) => {
                            setQuery(e.target.value);
                            setSel(0);
                        }}
                        onKeyDown={onKeyDown}
                        spellCheck={false}
                        disabled={!project}
                    />
                    <span className="picker-hint">esc</span>
                </div>

                <div className="picker-list" ref={listRef}>
                    {items.length === 0 && (
                        <div className="picker-empty">
                            {!project ? "pick a Rundeck project first" : res.status === "loading" && all.length === 0 ? "loading jobs..." : "no matches"}
                        </div>
                    )}
                    {items.map((cell, i) => (
                        <button
                            key={cell.job_id}
                            className={`picker-item${i === sel ? " sel" : ""}`}
                            onMouseEnter={() => {
                                if (mouseActive.current) setSel(i);
                            }}
                            onClick={() => activate(cell)}>
                            <span className="picker-icon command">
                                <IconCommand size={14} />
                            </span>
                            <span className="picker-name">{cell.name || cell.service}</span>
                            <span className="picker-sub">{jobPath(cell)}</span>
                        </button>
                    ))}
                </div>
            </div>
        </div>
    );
}

function jobSearchText(cell: MatrixCell): string {
    return [cell.name, cell.service, cell.group ?? "", cell.branch ?? "", cell.status ?? "", cell.user ?? ""].join(" ").toLowerCase();
}

function jobPath(cell: MatrixCell): string {
    return cell.group || cell.service;
}

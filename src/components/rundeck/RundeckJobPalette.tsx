import { useEffect, useMemo, useRef, useState } from "react";
import { type MatrixCell, type RundeckEnvSpec } from "../../api/rundeck";
import { useMouseActive } from "../../hooks/useMouseActive";
import { rankBy } from "../../lib/fuzzy";
import * as cmd from "../../state/commands";
import { useResource, useResourceEnabled } from "../../state/resources";
import { rndMatrixR, rndProjectsR } from "../../state/resources.defs";
import { inferEnv } from "../../state/rundeckShape";
import { useStore } from "../../state/store";
import { IconCommand, IconSearch } from "../Icons";

const MAX_RESULTS = 400;

interface JobRow {
    cell: MatrixCell;
    project: string;
}

export function RundeckJobPalette() {
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

    const projectsRes = useResource(rndProjectsR);
    const projects = projectsRes.data;
    const specs = useMemo<RundeckEnvSpec[]>(
        () => (projects ?? []).map((p) => ({ label: p.name, project: p.name, only_succeeded: true })),
        [projects],
    );
    const res = useResourceEnabled(specs.length > 0, rndMatrixR, specs);

    useEffect(() => {
        inputRef.current?.focus();
    }, []);

    const all = useMemo<JobRow[]>(() => {
        const rows: JobRow[] = [];
        for (const env of res.data?.envs ?? []) {
            for (const cell of env.cells) rows.push({ cell, project: env.project });
        }
        rows.sort((a, b) => a.project.localeCompare(b.project) || a.cell.service.localeCompare(b.cell.service));
        return rows;
    }, [res.data]);

    const items = useMemo(
        () => rankBy(query, all, (row) => [row.cell.name, row.cell.service, jobSearchText(row)]).slice(0, MAX_RESULTS),
        [all, query],
    );

    useEffect(() => {
        setSel((s) => Math.min(s, Math.max(0, items.length - 1)));
    }, [items.length]);

    useEffect(() => {
        const el = listRef.current?.querySelector<HTMLElement>(`.picker-item:nth-child(${sel + 1})`);
        el?.scrollIntoView({ block: "nearest" });
    }, [sel]);

    const activate = (row: JobRow | undefined) => {
        if (!row || !paneId) return;
        const { cell, project } = row;
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

    const loading = (projectsRes.status === "loading" && !projects) || (res.status === "loading" && all.length === 0);

    return (
        <div className="picker-backdrop" onMouseDown={cmd.closeRundeckJobPalette}>
            <div className="picker" onMouseDown={(e) => e.stopPropagation()}>
                <div className="picker-input-wrap">
                    <IconSearch size={15} className="picker-search-icon" />
                    <input
                        ref={inputRef}
                        className="picker-input"
                        placeholder="search Rundeck jobs..."
                        value={query}
                        onChange={(e) => {
                            setQuery(e.target.value);
                            setSel(0);
                        }}
                        onKeyDown={onKeyDown}
                        spellCheck={false}
                    />
                </div>

                <div className="picker-list" ref={listRef}>
                    {items.length === 0 && <div className="picker-empty">{loading ? "loading jobs..." : "no matches"}</div>}
                    {items.map((row, i) => (
                        <button
                            key={`${row.project}:${row.cell.job_id}`}
                            className={`picker-item${i === sel ? " sel" : ""}`}
                            onMouseEnter={() => {
                                if (mouseActive.current) setSel(i);
                            }}
                            onClick={() => activate(row)}>
                            <span className="picker-icon command">
                                <IconCommand size={14} />
                            </span>
                            <span className="picker-name">{row.cell.name || row.cell.service}</span>
                            <JobTags row={row} />
                        </button>
                    ))}
                </div>
            </div>
        </div>
    );
}

function jobSearchText(row: JobRow): string {
    const { cell, project } = row;
    return [project, cell.name, cell.service, cell.group ?? "", cell.branch ?? "", cell.status ?? "", cell.user ?? ""].join(" ").toLowerCase();
}

function jobParts(cell: MatrixCell): { env: string | null; type: string | null } {
    const segs = cell.group ? cell.group.split("/").filter(Boolean) : [];
    return { env: segs[0] ?? null, type: segs[1] ?? null };
}

function envKind(env: string): string {
    const e = env.toLowerCase();
    if (e.startsWith("prod")) return "prod";
    if (e.startsWith("stag")) return "staging";
    if (e.startsWith("pre")) return "preprod";
    if (e.startsWith("dev")) return "dev";
    return "other";
}

function JobTags({ row }: { row: JobRow }) {
    const { env, type } = jobParts(row.cell);
    return (
        <span className="picker-tags">
            <span className="picker-tag proj">{row.project}</span>
            {env && (
                <span className={`picker-tag env env-${envKind(env)}`}>
                    <span className="picker-tag-dot" />
                    {env}
                </span>
            )}
            {type && <span className="picker-tag type">{type}</span>}
        </span>
    );
}

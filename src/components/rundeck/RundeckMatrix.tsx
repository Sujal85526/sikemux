import { useMemo } from "react";
import { type MatrixCell, type RundeckEnvSpec } from "../../api/rundeck";
import * as cmd from "../../state/commands";
import { useResourceEnabled } from "../../state/resources";
import { rndMatrixR } from "../../state/resources.defs";
import { envFolderOf, inferEnv } from "../../state/rundeckShape";
import { useStore } from "../../state/store";
import { IconSearch } from "../Icons";
import { BRANCH_GLYPH, branchKind, statusKind } from "./branchStyle";
import { PRIMARY_SHORTCUT } from "../../lib/platform";

interface Props {
    paneId: string;
    active: boolean;
}

export function RundeckMatrix({ paneId, active }: Props) {
    const project = useStore((s) => s.rundeck.activeProject);
    const envFolder = useStore((s) => s.rundeck.activeEnvFolder);

    const specs = useMemo<RundeckEnvSpec[]>(() => (project ? [{ label: project, project, only_succeeded: true }] : []), [project]);

    const res = useResourceEnabled(active && specs.length > 0, rndMatrixR, specs);

    const data = res.data;
    const env = data?.envs[0] ?? null;
    const cells = useMemo(() => {
        const list = (env?.cells ?? []).filter((c) => {
            if (!envFolder) return true;
            return envFolderOf(c.group) === envFolder;
        });
        list.sort((a, b) => a.name.localeCompare(b.name));
        return list;
    }, [env, envFolder]);
    const loading = res.status === "loading" && !data;

    const groups = useMemo(() => {
        if (envFolder) return [{ env: null, cells }];
        const map = new Map<string, MatrixCell[]>();
        for (const c of cells) {
            const folder = envFolderOf(c.group) ?? "_ungrouped";
            const arr = map.get(folder) ?? [];
            arr.push(c);
            map.set(folder, arr);
        }
        if (map.size === 1 && map.has("_ungrouped")) {
            return [{ env: null, cells }];
        }
        return [...map.entries()]
            .sort(([a], [b]) => {
                if (a === "_ungrouped") return 1;
                if (b === "_ungrouped") return -1;
                return a.localeCompare(b);
            })
            .map(([folder, group]) => ({
                env: folder === "_ungrouped" ? null : folder,
                cells: group,
            }));
    }, [cells, envFolder]);

    if (!project) {
        return <div className="rnd-empty muted">Pick a Rundeck project from the top bar.</div>;
    }

    return (
        <div className="rnd-list">
            <div className="rnd-list-toolbar">
                <span className="rnd-list-meta">
                    <span className="rnd-list-meta-n">{cells.length}</span>
                    <span className="rnd-list-meta-l">services</span>
                    <span className="rnd-list-meta-sep">·</span>
                    <span className="rnd-list-meta-l">project</span>
                    <span className="rnd-list-meta-v">{project}</span>
                    {data && (
                        <>
                            <span className="rnd-list-meta-sep">·</span>
                            <span className="rnd-list-meta-l">{data.elapsed_ms}ms</span>
                        </>
                    )}
                    {loading && (
                        <>
                            <span className="rnd-list-meta-sep">·</span>
                            <span className="rnd-spinner inline" />
                            <span className="rnd-list-meta-l">refreshing</span>
                        </>
                    )}
                </span>
                <div className="rnd-list-tools">
                    <button className="rnd-btn-sm" onClick={cmd.openRundeckJobPalette} disabled={cells.length === 0} title="Search jobs">
                        <IconSearch size={12} />
                        search
                    </button>
                    <button className="rnd-btn-sm" onClick={() => res.refresh()} disabled={loading} title="Refresh">
                        refresh
                    </button>
                </div>
            </div>

            {env?.error && <div className="rnd-banner warn">{env.error}</div>}
            {res.error && !data && (
                <div className="rnd-empty">
                    <div className="rnd-empty-msg">couldn't load — {res.error}</div>
                    <button className="rnd-btn-sm" onClick={() => res.refresh()}>
                        retry
                    </button>
                </div>
            )}

            <div className="rnd-list-rows">
                {cells.length === 0 && !loading && (
                    <div className="rnd-empty muted compact">
                        No jobs in <strong>{project}</strong>.
                    </div>
                )}
                {groups.map((g) => (
                    <div className="rnd-group" key={g.env ?? "_flat"}>
                        {g.env && (
                            <div className="rnd-group-head">
                                <span className="rnd-group-folder">{g.env}/</span>
                                <span className="rnd-group-count">{g.cells.length}</span>
                            </div>
                        )}
                        {g.cells.map((c) => (
                            <DeployRow key={c.job_id} paneId={paneId} project={project} cell={c} />
                        ))}
                    </div>
                ))}
            </div>
        </div>
    );
}

function DeployRow({ paneId, project, cell }: { paneId: string; project: string; cell: MatrixCell }) {
    const branch = cell.branch ?? null;
    const k = branchKind(branch);
    const sk = statusKind(cell.status);
    const env = inferEnv(project, cell.group);

    const open = () =>
        cmd.rundeckPush(paneId, {
            kind: "service",
            env,
            project,
            service: cell.service,
            jobId: cell.job_id,
        });

    const deploy = (e: React.MouseEvent) => {
        e.stopPropagation();
        open();
        cmd.rundeckPush(paneId, {
            kind: "deploy",
            env,
            project,
            service: cell.service,
            jobId: cell.job_id,
            branch: branch ?? "",
        });
    };

    const openLast = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (cell.execution_id == null) return;
        open();
        cmd.rundeckPush(paneId, {
            kind: "execution",
            executionId: cell.execution_id,
            project,
            service: cell.service,
            env,
            jobId: cell.job_id,
        });
    };

    return (
        <div
            className="rnd-list-row"
            title={cell.error ?? undefined}
            onClick={(e) => {
                if (e.metaKey || e.ctrlKey) deploy(e);
                else open();
            }}>
            <span className={`rnd-row-glyph rnd-branch-${k}`}>{BRANCH_GLYPH[k]}</span>
            <span className="rnd-row-svc">{cell.name}</span>
            <span className={`rnd-row-branch rnd-branch-${k}`} title={branch ?? ""}>
                {branch ?? "—"}
            </span>
            <span className={`rnd-row-status rnd-status-${sk}`}>{cell.status ?? "—"}</span>
            <span className="rnd-row-user">{cell.user ?? "—"}</span>
            <span className="rnd-row-when">{cell.ended_at ? relativeTime(cell.ended_at) : "—"}</span>
            <span className="rnd-row-actions" onClick={(e) => e.stopPropagation()}>
                {cell.execution_id != null && (
                    <button className="rnd-row-action" onClick={openLast} title="View last execution">
                        last
                    </button>
                )}
                <button className="rnd-row-action accent" onClick={deploy} title={`Deploy (${PRIMARY_SHORTCUT}click anywhere on the row)`}>
                    deploy
                </button>
            </span>
        </div>
    );
}

function relativeTime(iso: string): string {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return "";
    const dt = (Date.now() - t) / 1000;
    if (dt < 60) return `${Math.floor(dt)}s ago`;
    if (dt < 3600) return `${Math.floor(dt / 60)}m ago`;
    if (dt < 86400) return `${Math.floor(dt / 3600)}h ago`;
    return `${Math.floor(dt / 86400)}d ago`;
}

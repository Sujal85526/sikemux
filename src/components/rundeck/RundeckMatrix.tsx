import { useMemo } from "react";
import { type MatrixCell, type RundeckEnvSpec } from "../../api/rundeck";
import * as cmd from "../../state/commands";
import { useResource } from "../../state/resources";
import { rndMatrixR } from "../../state/resources.defs";
import {
  envFolderOf,
  inferEnv,
  isLegacyProject,
} from "../../state/rundeckShape";
import { useStore } from "../../state/store";
import { BRANCH_GLYPH, branchKind, statusKind } from "./branchStyle";

interface Props {
  paneId: string;
}

/** Job list for the currently-selected Rundeck project.
 *
 *  Legacy projects (dev/staging/Preprod/production) render a flat list
 *  of `backend/<svc>` rows. Product projects (contractiq/marketingiq/
 *  channeliq) render the jobs grouped by env folder (the first segment
 *  of each job's group path — `dev/backend/...` → `dev` group header).
 *  No synthesis: this is exactly the tree the API hands us. */
export function RundeckMatrix({ paneId }: Props) {
  const project = useStore((s) => s.rundeck.activeProject);
  const envFolder = useStore((s) => s.rundeck.activeEnvFolder);

  const specs = useMemo<RundeckEnvSpec[]>(
    // We reuse the matrix endpoint with a single spec — the label is just
    // a display tag, the real key is the project.
    () => (project ? [{ label: project, project, only_succeeded: true }] : []),
    [project],
  );

  const res = useResource(rndMatrixR, specs);

  const data = res.data;
  const env = data?.envs[0] ?? null;
  // Apply the tree-driven env-folder filter (product projects only) BEFORE
  // sorting/grouping so totals + group headers reflect the visible scope.
  const cells = useMemo(() => {
    const list = (env?.cells ?? []).filter((c) => {
      if (!envFolder) return true;
      if (isLegacyProject(project)) return true;
      return envFolderOf(c.group) === envFolder;
    });
    list.sort((a, b) => a.name.localeCompare(b.name));
    return list;
  }, [env, envFolder, project]);
  const loading = res.status === "loading" && !data;

  // Group cells by env folder when the project is product-style and no
  // explicit folder filter is active. When a folder filter IS active we
  // show a flat list (the folder header would be redundant). Legacy
  // projects always render flat.
  const groups = useMemo(() => {
    if (isLegacyProject(project) || envFolder) {
      return [{ env: null, cells }];
    }
    const map = new Map<string, MatrixCell[]>();
    for (const c of cells) {
      const folder = envFolderOf(c.group) ?? "_ungrouped";
      const arr = map.get(folder) ?? [];
      arr.push(c);
      map.set(folder, arr);
    }
    // Stable order: alphabetical, with `_ungrouped` last.
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
  }, [cells, project, envFolder]);

  if (!project) {
    return (
      <div className="rnd-empty muted">
        Pick a Rundeck project from the top bar.
      </div>
    );
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
        <button
          className="rnd-btn-sm"
          onClick={() => res.refresh()}
          disabled={loading}
          title="Refresh"
        >
          refresh
        </button>
      </div>

      {env?.error && (
        <div className="rnd-banner warn">{env.error}</div>
      )}
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

function DeployRow({
  paneId,
  project,
  cell,
}: {
  paneId: string;
  project: string;
  cell: MatrixCell;
}) {
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
    cmd.rundeckPush(paneId, {
      kind: "execution",
      executionId: cell.execution_id,
      project,
      service: cell.service,
    });
  };

  return (
    <div
      className="rnd-list-row"
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey) deploy(e);
        else open();
      }}
    >
      <span className={`rnd-row-glyph rnd-branch-${k}`}>
        {BRANCH_GLYPH[k]}
      </span>
      <span className="rnd-row-svc">{cell.name}</span>
      <span className={`rnd-row-branch rnd-branch-${k}`} title={branch ?? ""}>
        {branch ?? "—"}
      </span>
      <span className={`rnd-row-status rnd-status-${sk}`}>
        {cell.status ?? "—"}
      </span>
      <span className="rnd-row-user">{cell.user ?? "—"}</span>
      <span className="rnd-row-when">
        {cell.ended_at ? relativeTime(cell.ended_at) : "—"}
      </span>
      <span className="rnd-row-actions" onClick={(e) => e.stopPropagation()}>
        {cell.execution_id != null && (
          <button
            className="rnd-row-action"
            onClick={openLast}
            title="View last execution"
          >
            last
          </button>
        )}
        <button
          className="rnd-row-action accent"
          onClick={deploy}
          title="Deploy (⌘-click anywhere on the row)"
        >
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

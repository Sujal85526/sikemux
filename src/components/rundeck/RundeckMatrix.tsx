import { useMemo } from "react";
import { type MatrixCell, type RundeckEnvSpec } from "../../api/rundeck";
import * as cmd from "../../state/commands";
import { useResource } from "../../state/resources";
import { rndMatrixR } from "../../state/resources.defs";
import { useStore } from "../../state/store";
import { BRANCH_GLYPH, branchKind, statusKind } from "./branchStyle";

interface Props {
  paneId: string;
}

/** Single-env deployments list. Env picker lives in the top bar — this view
 *  is just "what's deployed where, for the picked env." One row per service,
 *  click → service detail, ⌘-click → deploy directly. */
export function RundeckMatrix({ paneId }: Props) {
  const envs = useStore((s) => s.rundeck.envs);
  const activeEnv = useStore((s) => s.rundeck.activeEnv);

  // Resolve the env label → real Rundeck project. Falls back to first env
  // when the persisted value is stale (e.g. user renamed an env).
  const envSpec = useMemo(
    () => envs.find((e) => e.label === activeEnv) ?? envs[0],
    [envs, activeEnv],
  );

  const specs = useMemo<RundeckEnvSpec[]>(
    () =>
      envSpec
        ? [{ label: envSpec.label, project: envSpec.project, only_succeeded: true }]
        : [],
    [envSpec],
  );

  const res = useResource(rndMatrixR, specs);

  const data = res.data;
  const env = data?.envs[0] ?? null;
  const cells = useMemo(() => {
    const list = env?.cells.slice() ?? [];
    list.sort((a, b) => a.service.localeCompare(b.service));
    return list;
  }, [env]);
  const loading = res.status === "loading" && !data;

  if (!envSpec) {
    return (
      <div className="rnd-empty muted">
        No environments configured.
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
          <span className="rnd-list-meta-v">{envSpec.project}</span>
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
            No services have deployed to <strong>{envSpec.label}</strong> yet.
          </div>
        )}
        {cells.map((c) => (
          <DeployRow
            key={c.service}
            paneId={paneId}
            envLabel={envSpec.label}
            project={envSpec.project}
            cell={c}
          />
        ))}
      </div>
    </div>
  );
}

function DeployRow({
  paneId,
  envLabel,
  project,
  cell,
}: {
  paneId: string;
  envLabel: string;
  project: string;
  cell: MatrixCell;
}) {
  const branch = cell.branch ?? null;
  const k = branchKind(branch);
  const sk = statusKind(cell.status);

  const open = () =>
    cmd.rundeckPush(paneId, {
      kind: "service",
      env: envLabel,
      project,
      service: cell.service,
      jobId: cell.job_id,
    });

  const deploy = (e: React.MouseEvent) => {
    e.stopPropagation();
    cmd.rundeckPush(paneId, {
      kind: "deploy",
      env: envLabel,
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
      <span className="rnd-row-svc">{cell.service}</span>
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

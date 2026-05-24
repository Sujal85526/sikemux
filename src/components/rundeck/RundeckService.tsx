import { useEffect } from "react";
import { type RundeckExecution } from "../../api/rundeck";
import * as cmd from "../../state/commands";
import { useResource } from "../../state/resources";
import { rndExecutionsR } from "../../state/resources.defs";
import { useStore } from "../../state/store";
import { BRANCH_GLYPH, branchKind, statusKind } from "./branchStyle";

interface Props {
  paneId: string;
  level: {
    kind: "service";
    env: string;
    project: string;
    service: string;
    jobId: string;
  };
}

export function RundeckService({ paneId, level }: Props) {
  const execs = useResource(rndExecutionsR, level.jobId, 25);

  return (
    <div className="rnd-service">
      <div className="rnd-section-head">
        <div className="rnd-section-title">
          <span className="rnd-section-eyebrow">{level.env}</span>
          <span className="rnd-section-name">{level.service}</span>
          <span className="rnd-section-proj">{level.project}</span>
        </div>
        <div className="rnd-section-actions">
          <button
            className="rnd-btn rnd-btn-primary"
            onClick={() => deployCurrentBranch(paneId, level)}
            title="Deploy current local branch"
          >
            deploy current branch
          </button>
          <button
            className="rnd-btn"
            onClick={() => redeployLast(paneId, level, execs.data ?? [])}
            disabled={!execs.data?.length}
            title="Redeploy the last successful branch"
          >
            redeploy last
          </button>
          <button
            className="rnd-btn-sm"
            onClick={() => execs.refresh()}
            disabled={execs.status === "loading"}
          >
            refresh
          </button>
        </div>
      </div>

      <div className="rnd-history">
        <div className="rnd-history-head">
          <span>recent executions</span>
          <span className="rnd-history-help">
            click a row to open the live view
          </span>
        </div>
        {execs.status === "loading" && !execs.data && (
          <div className="rnd-empty muted">
            <span className="rnd-spinner inline" /> loading…
          </div>
        )}
        {execs.data?.map((ex) => (
          <ExecutionRow
            key={ex.id}
            paneId={paneId}
            level={level}
            ex={ex}
          />
        ))}
        {execs.data && execs.data.length === 0 && (
          <div className="rnd-empty muted">
            No executions for this job yet.
          </div>
        )}
      </div>
    </div>
  );
}

function ExecutionRow({
  paneId,
  level,
  ex,
}: {
  paneId: string;
  level: { env: string; project: string; service: string };
  ex: RundeckExecution;
}) {
  const branch = ex.job?.options?.BRANCH ?? null;
  const kind = branchKind(branch);
  const sk = statusKind(ex.status);
  const started = ex["date-started"]?.date ?? null;
  const ended = ex["date-ended"]?.date ?? null;
  const dur = duration(started, ended);

  return (
    <button
      className="rnd-exec-row"
      onClick={() =>
        cmd.rundeckPush(paneId, {
          kind: "execution",
          executionId: ex.id,
          project: level.project,
          service: level.service,
        })
      }
    >
      <span className={`rnd-exec-status rnd-status-${sk}`}>{ex.status}</span>
      <span className="rnd-exec-id">#{ex.id}</span>
      <span className={`rnd-exec-branch rnd-branch-${kind}`}>
        <span className="rnd-cell-glyph">{BRANCH_GLYPH[kind]}</span>
        {branch ?? "—"}
      </span>
      <span className="rnd-exec-user">{ex.user ?? "—"}</span>
      <span className="rnd-exec-when">
        {started ? formatTime(started) : "—"}
      </span>
      <span className="rnd-exec-dur">{dur}</span>
    </button>
  );
}

async function deployCurrentBranch(
  paneId: string,
  level: { env: string; project: string; service: string; jobId: string },
) {
  // Need a local branch — use the active session's cwd to introspect via plan.
  const session = useStore.getState().sessions[
    useStore.getState().activeSessionId
  ];
  const repoPath = session?.cwd ?? "";
  // Heuristic default: 'main'. The deploy view will run a fresh plan() and
  // surface the real current branch — at which point the user can edit.
  cmd.rundeckPush(paneId, {
    kind: "deploy",
    env: level.env,
    project: level.project,
    service: level.service,
    jobId: level.jobId,
    branch: "main",
  });
  void repoPath;
}

function redeployLast(
  paneId: string,
  level: { env: string; project: string; service: string; jobId: string },
  execs: RundeckExecution[],
) {
  const lastOk = execs.find((e) => e.status === "succeeded");
  const branch = lastOk?.job?.options?.BRANCH ?? "main";
  cmd.rundeckPush(paneId, {
    kind: "deploy",
    env: level.env,
    project: level.project,
    service: level.service,
    jobId: level.jobId,
    branch,
  });
}

function formatTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const d = new Date(t);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function duration(start: string | null, end: string | null): string {
  if (!start) return "";
  const a = Date.parse(start);
  const b = end ? Date.parse(end) : Date.now();
  if (Number.isNaN(a) || Number.isNaN(b)) return "";
  const s = Math.max(0, Math.round((b - a) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest ? `${m}m ${rest}s` : `${m}m`;
}

// Tiny effect-pass to silence unused warnings if jobId changes — would let us
// prefetch the plan in the background later.
export function _useTouch(_: unknown) {
  useEffect(() => {}, [_]);
}

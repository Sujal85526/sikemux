import { useEffect, useState } from "react";
import { git } from "../../api/git";
import { rundeckApi, type RundeckExecution } from "../../api/rundeck";
import * as cmd from "../../state/commands";
import { useResourceEnabled } from "../../state/resources";
import { rndExecutionsR } from "../../state/resources.defs";
import { useStore } from "../../state/store";
import { IconFetch, IconGit, IconRefresh, IconRun } from "../Icons";
import { BRANCH_GLYPH, branchKind, statusKind } from "./branchStyle";

interface Props {
    paneId: string;
    level: {
        kind: "service";
        env: string;
        project: string;
        service: string;
        jobId: string;
        repoPath?: string;
    };
    active: boolean;
}

export function RundeckService({ paneId, level, active }: Props) {
    const execs = useResourceEnabled(active, rndExecutionsR, level.jobId, 25);
    const prodEnvs = useStore((s) => s.rundeck.prodEnvs);
    const [actionError, setActionError] = useState<string | null>(null);
    const [manualBranch, setManualBranch] = useState("");
    const tone = envTone(level.env, prodEnvs);

    return (
        <div className="rnd-service">
            <div className="rnd-svc-bar">
                <span className={`rnd-env rnd-env-${tone}`} title={`environment: ${level.env}`}>
                    <span className="rnd-env-dot" />
                    {level.env}
                </span>
                <ServicePath service={level.service} />
                <span className="rnd-svc-proj">{level.project}</span>

                <span className="rnd-svc-spacer" />

                <form
                    className="rnd-composer"
                    onSubmit={(e) => {
                        e.preventDefault();
                        deployBranch(paneId, level, manualBranch, setActionError);
                    }}>
                    <input
                        type="text"
                        value={manualBranch}
                        onChange={(e) => setManualBranch(e.target.value)}
                        placeholder="branch name"
                        spellCheck={false}
                        autoCapitalize="off"
                        autoCorrect="off"
                        title="Branch to deploy"
                    />
                    <button className="rnd-composer-go" disabled={!manualBranch.trim()} title="Review and deploy this branch">
                        <IconRun size={11} />
                        deploy
                    </button>
                </form>

                <span className="rnd-svc-div" />

                <button
                    className="rnd-ghost-btn"
                    onClick={() => void deployCurrentBranch(paneId, level, setActionError)}
                    title="Deploy current local branch">
                    <IconGit size={13} />
                    current branch
                </button>
                <button
                    className="rnd-ghost-btn"
                    onClick={() => void redeployLast(paneId, level, execs.data ?? [], setActionError)}
                    disabled={!execs.data?.length}
                    title="Redeploy the last successful branch">
                    <IconFetch size={13} />
                    redeploy last
                </button>
                <button
                    className="rnd-icon-btn"
                    onClick={() => execs.refresh()}
                    disabled={execs.status === "loading"}
                    title="Refresh executions">
                    <IconRefresh size={13} />
                </button>
            </div>

            {actionError && <div className="rnd-banner danger">{actionError}</div>}

            <div className="rnd-history">
                <div className="rnd-history-head">
                    <span>recent executions</span>
                    <span className="rnd-history-help">click a row to open the live view</span>
                </div>
                {execs.status === "loading" && !execs.data && (
                    <div className="rnd-empty muted">
                        <span className="rnd-spinner inline" /> loading…
                    </div>
                )}
                {execs.data?.map((ex) => (
                    <ExecutionRow key={ex.id} paneId={paneId} level={level} ex={ex} />
                ))}
                {execs.data && execs.data.length === 0 && <div className="rnd-empty muted">No executions for this job yet.</div>}
            </div>
        </div>
    );
}

/** Renders a service path with dimmed ancestors and a bright leaf, e.g.
 *  dev / backend / **content-service** — so the eye lands on the actual job. */
function ServicePath({ service }: { service: string }) {
    const parts = service
        .split("/")
        .map((p) => p.trim())
        .filter(Boolean);
    if (parts.length === 0) return <span className="rnd-svc-path">{service}</span>;
    return (
        <span className="rnd-svc-path" title={service}>
            {parts.map((part, i) => (
                <span key={`${i}-${part}`} className="rnd-svc-part">
                    {i > 0 && <span className="rnd-svc-slash">/</span>}
                    <span className={i === parts.length - 1 ? "rnd-svc-leaf" : "rnd-svc-seg"}>{part}</span>
                </span>
            ))}
        </span>
    );
}

/** Cosmetic env-pill tone: configured prod envs → danger, staging-ish → warn,
 *  everything else → live (mint). */
function envTone(env: string, prodEnvs: string[]): "prod" | "stg" | "dev" {
    if (prodEnvs.includes(env)) return "prod";
    return /stag|stg|uat|qa|pre/.test(env.toLowerCase()) ? "stg" : "dev";
}

function ExecutionRow({
    paneId,
    level,
    ex,
}: {
    paneId: string;
    level: { env: string; project: string; service: string; jobId: string; repoPath?: string };
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
                    env: level.env,
                    jobId: level.jobId,
                    repoPath: level.repoPath,
                })
            }>
            <span className={`rnd-exec-status rnd-status-${sk}`}>{ex.status}</span>
            <span className="rnd-exec-id">#{ex.id}</span>
            <span className={`rnd-exec-branch rnd-branch-${kind}`}>
                <span className="rnd-cell-glyph">{BRANCH_GLYPH[kind]}</span>
                {branch ?? "—"}
            </span>
            <span className="rnd-exec-user">{ex.user ?? "—"}</span>
            <span className="rnd-exec-when">{started ? formatTime(started) : "—"}</span>
            <span className="rnd-exec-dur">{dur}</span>
        </button>
    );
}

function deployBranch(
    paneId: string,
    level: { env: string; project: string; service: string; jobId: string; repoPath?: string },
    branch: string,
    setError: (message: string | null) => void,
) {
    const branchValue = branch.trim();
    if (!branchValue) {
        setError("Enter a branch to deploy.");
        return;
    }
    setError(null);
    cmd.rundeckPush(paneId, {
        kind: "deploy",
        env: level.env,
        project: level.project,
        service: level.service,
        jobId: level.jobId,
        branch: branchValue,
        repoPath: level.repoPath,
    });
}

async function deployCurrentBranch(
    paneId: string,
    level: { env: string; project: string; service: string; jobId: string; repoPath?: string },
    setError: (message: string | null) => void,
) {
    setError(null);
    const repoPath = level.repoPath ?? "";
    let branch = "";
    if (repoPath) {
        try {
            const status = await git.status(repoPath);
            branch = status.branch === "HEAD" ? "" : status.branch;
        } catch (e) {
            setError(typeof e === "object" && e && "message" in e ? String((e as { message: string }).message) : String(e));
        }
    }
    cmd.rundeckPush(paneId, {
        kind: "deploy",
        env: level.env,
        project: level.project,
        service: level.service,
        jobId: level.jobId,
        branch,
        repoPath,
    });
}

async function redeployLast(
    paneId: string,
    level: { env: string; project: string; service: string; jobId: string; repoPath?: string },
    execs: RundeckExecution[],
    setError: (message: string | null) => void,
) {
    setError(null);
    let branch = execs.find((e) => e.status === "succeeded" && e.job?.options?.BRANCH)?.job?.options?.BRANCH ?? "";
    if (!branch) {
        try {
            const latest = await rundeckApi.executions(level.jobId, 1, true);
            branch = latest[0]?.job?.options?.BRANCH ?? "";
        } catch (e) {
            setError(typeof e === "object" && e && "message" in e ? String((e as { message: string }).message) : String(e));
            return;
        }
    }
    if (!branch) {
        setError("No successful execution with a BRANCH option found.");
        return;
    }
    cmd.rundeckPush(paneId, {
        kind: "deploy",
        env: level.env,
        project: level.project,
        service: level.service,
        jobId: level.jobId,
        branch,
        repoPath: level.repoPath,
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

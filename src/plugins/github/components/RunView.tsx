import { useEffect, useState } from "react";
import { confirmDialog, notify, openUrl, reportError, swallow } from "../../../plugin-api/host";
import { invalidate, useResourceEnabled } from "../../../plugin-api/resources";
import { EmptyState, IconChevron, IconClose, IconRefresh, SkeletonRows, Tooltip } from "../../../plugin-api/ui";
import { actionsApi, failureMessage, type Job, type RepoRef, type Run } from "../api";
import { actionsRunAttemptR, actionsRunR } from "../resources";
import { elapsedMs, failedStep, formatAgo, formatDuration, isRunning, jobsSummary, outcomeOf, OUTCOME_LABEL } from "../runStatus";
import { closeRun, updateView } from "../state";
import { OutcomeIcon } from "./ActionsIcon";
import { Annotations } from "./Annotations";
import { Approvals } from "./Approvals";
import { Artifacts } from "./Artifacts";
import { useNow } from "./hooks";
import { JobLogView } from "./JobLogView";

const refreshRuns = () => invalidate((kind) => kind === "gha.runs" || kind === "gha.run");

function StepRow({ step, now }: { step: Job["steps"][number]; now: number }) {
    const outcome = outcomeOf(step);
    return (
        <div className="gha-step" data-outcome={outcome}>
            <OutcomeIcon outcome={outcome} size={11} />
            <span className="gha-step-name">{step.name}</span>
            <span className="gha-dim">{formatDuration(elapsedMs(step.startedAt, step.completedAt, now))}</span>
        </div>
    );
}

function JobCard({
    job,
    repo,
    now,
    open,
    active,
    onToggle,
    canWrite,
}: {
    job: Job;
    repo: RepoRef;
    now: number;
    open: boolean;
    active: boolean;
    onToggle: () => void;
    canWrite: boolean;
}) {
    const outcome = outcomeOf(job);
    const stopped = failedStep(job);
    const rerun = (debug: boolean) =>
        void actionsApi
            .rerunJob(repo, job.id, debug)
            .then(() => {
                notify("success", `Re-running ${job.name}`);
                refreshRuns();
            })
            .catch(reportError(`Could not re-run ${job.name}`));

    return (
        <div className="gha-job" data-open={open ? "1" : "0"} data-outcome={outcome}>
            <button type="button" className="gha-job-head" onClick={onToggle} aria-expanded={open}>
                <span className="gha-chevron" data-open={open ? "1" : "0"}>
                    <IconChevron size={11} />
                </span>
                <OutcomeIcon outcome={outcome} />
                <span className="gha-job-name">{job.name}</span>
                {stopped && !open && <span className="gha-job-stopped">stopped at {stopped.name}</span>}
                <span className="gha-dim">{formatDuration(elapsedMs(job.startedAt, job.completedAt, now))}</span>
            </button>
            {open && (
                <div className="gha-job-body">
                    <div className="gha-job-actions">
                        {job.runner && <span className="gha-dim">on {job.runner}</span>}
                        {canWrite && job.status === "completed" && (
                            <button type="button" className="gha-link" onClick={() => rerun(false)}>
                                Re-run this job
                            </button>
                        )}
                        {canWrite && job.status === "completed" && (
                            <button type="button" className="gha-link" onClick={() => rerun(true)} title="Re-run with the runner's debug logging on">
                                with debug logs
                            </button>
                        )}
                        {job.url && (
                            <button type="button" className="gha-link" onClick={() => void openUrl(job.url ?? "").catch(swallow("open GitHub"))}>
                                On GitHub
                            </button>
                        )}
                    </div>
                    {job.steps.length > 0 && (
                        <div className="gha-steps">
                            {job.steps.map((step) => (
                                <StepRow key={`${step.number}-${step.name}`} step={step} now={now} />
                            ))}
                        </div>
                    )}
                    {job.checkRunId !== null && <Annotations repo={repo} checkRunId={job.checkRunId} active={active} />}
                    <JobLogView repo={repo} job={job} active={active} />
                </div>
            )}
        </div>
    );
}

function Header({ run, repo, now, canWrite, onRefresh }: { run: Run; repo: RepoRef; now: number; canWrite: boolean; onRefresh: () => void }) {
    const outcome = outcomeOf(run);
    const live = isRunning(run);
    const act = (what: string, work: Promise<void>) =>
        void work
            .then(() => {
                notify("success", what);
                refreshRuns();
            })
            .catch(reportError(`Could not ${what.toLowerCase()}`));

    const cancel = async () => {
        const sure = await confirmDialog({
            title: "Cancel this run?",
            body: `Run #${run.runNumber} will stop where it is.`,
            confirmLabel: "Cancel run",
            destructive: true,
        });
        if (sure) act("Cancelled the run", actionsApi.cancel(repo, run.id));
    };

    return (
        <div className="gha-run-head">
            <div className="gha-run-head-main">
                <OutcomeIcon outcome={outcome} size={15} />
                <span className="gha-run-head-title">{run.title || run.name}</span>
                <span className="gha-badge" data-outcome={outcome}>
                    {OUTCOME_LABEL[outcome]}
                </span>
            </div>
            <div className="gha-run-head-sub">
                <span>{run.name}</span>
                <span className="gha-mono">#{run.runNumber}</span>
                {run.attempt > 1 && <span className="gha-dim">attempt {run.attempt}</span>}
                <span>{run.event}</span>
                {run.branch && <span className="gha-branch">{run.branch}</span>}
                <span className="gha-mono gha-dim">{run.shortSha}</span>
                {run.actor && <span className="gha-dim">{run.actor}</span>}
                <span>{formatDuration(elapsedMs(run.startedAt ?? run.createdAt, live ? null : run.updatedAt, now))}</span>
                <span className="gha-dim">{formatAgo(run.createdAt, now)}</span>
            </div>
            <div className="gha-run-head-actions">
                {canWrite && live && (
                    <button type="button" className="gha-btn danger" onClick={() => void cancel()}>
                        Cancel
                    </button>
                )}
                {canWrite && !live && (
                    <>
                        <button
                            type="button"
                            className="gha-btn"
                            onClick={() => act("Re-running the failed jobs", actionsApi.rerun(repo, run.id, true))}>
                            Re-run failed
                        </button>
                        <button type="button" className="gha-btn" onClick={() => act("Re-running everything", actionsApi.rerun(repo, run.id, false))}>
                            Re-run all
                        </button>
                    </>
                )}
                <button type="button" className="gha-link" onClick={() => void openUrl(run.url).catch(swallow("open GitHub"))}>
                    On GitHub
                </button>
                <Tooltip label="Refresh">
                    <button type="button" className="gha-icon-btn" onClick={onRefresh} aria-label="Refresh run">
                        <IconRefresh size={13} />
                    </button>
                </Tooltip>
            </div>
        </div>
    );
}

interface Props {
    paneId: string;
    repo: RepoRef;
    runId: number;
    openJob: number | null;
    active: boolean;
    canWrite: boolean;
}

export function RunView({ paneId, repo, runId, openJob, active, canWrite }: Props) {
    const [attempt, setAttempt] = useState<number | null>(null);
    const detail = useResourceEnabled(active && attempt === null, actionsRunR, repo, runId);
    const older = useResourceEnabled(active && attempt !== null, actionsRunAttemptR, repo, runId, attempt ?? 0);
    const shown = attempt === null ? detail : older;
    const [live, setLive] = useState<{ run: Run | null; jobs: Job[] } | null>(null);

    const run = (attempt === null ? live?.run : null) ?? shown.data?.run ?? null;
    const jobs = attempt === null && live?.jobs.length ? live.jobs : (shown.data?.jobs ?? []);
    const moving = attempt === null && !!run && isRunning(run);
    const now = useNow(active && moving);

    // While a run is going, the backend pushes the whole run and its jobs on
    // every tick, and the list behind this view is re-read once it ends.
    useEffect(() => {
        if (!active || !moving) return;
        let streamId: number | null = null;
        let stopped = false;
        void actionsApi
            .watchStart(repo, runId, (tick) => {
                if (tick.run) setLive({ run: tick.run, jobs: tick.jobs });
                if (tick.finished) refreshRuns();
            })
            .then((id) => {
                if (stopped) void actionsApi.watchStop(id);
                else streamId = id;
            })
            .catch(swallow("watch the run"));
        return () => {
            stopped = true;
            if (streamId !== null) void actionsApi.watchStop(streamId).catch(swallow("stop watching the run"));
        };
    }, [active, moving, repo, runId]);

    useEffect(() => setLive(null), [runId]);

    if (shown.status === "loading" && !run) return <SkeletonRows rows={8} label="Loading run" />;
    if (shown.error && !run) {
        return (
            <EmptyState
                title="Could not read the run"
                message={failureMessage(shown.error)}
                tone="error"
                action={{ label: "Try again", onClick: () => void shown.refresh() }}
            />
        );
    }
    if (!run) return <EmptyState message="That run is gone." />;

    const summary = jobsSummary(jobs);
    return (
        <div className="gha-run-view">
            <button type="button" className="gha-back" onClick={() => closeRun(paneId)}>
                <IconClose size={11} /> Back to runs
            </button>
            <Header run={run} repo={repo} now={now} canWrite={canWrite} onRefresh={() => void shown.refresh()} />
            {run.attempt > 1 && (
                <div className="gha-attempts">
                    <span className="gha-dim">Attempts</span>
                    {Array.from({ length: run.attempt }, (_, index) => index + 1).map((number) => (
                        <button
                            key={number}
                            type="button"
                            className="gha-chip"
                            data-on={(attempt ?? run.attempt) === number ? "1" : "0"}
                            onClick={() => setAttempt(number === run.attempt ? null : number)}>
                            #{number}
                        </button>
                    ))}
                </div>
            )}
            <Approvals repo={repo} runId={runId} status={run.status} conclusion={run.conclusion} active={active} />
            <Artifacts repo={repo} runId={runId} active={active && run.status === "completed"} />
            <div className="gha-jobs-head">
                {summary.total > 0 ? (
                    <span>
                        {summary.done} of {summary.total} job{summary.total === 1 ? "" : "s"} done
                        {summary.failed > 0 && <span className="gha-failed-count"> · {summary.failed} failed</span>}
                    </span>
                ) : (
                    <span className="gha-dim">No jobs yet</span>
                )}
            </div>
            <div className="gha-jobs">
                {jobs.map((job) => (
                    <JobCard
                        key={job.id}
                        job={job}
                        repo={repo}
                        now={now}
                        active={active}
                        canWrite={canWrite}
                        open={openJob === job.id}
                        onToggle={() => updateView(paneId, { job: openJob === job.id ? null : job.id })}
                    />
                ))}
            </div>
        </div>
    );
}

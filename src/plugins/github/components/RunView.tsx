import { memo, useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { confirmDialog, copyText, notify, openUrl, reportError, swallow } from "../../../plugin-api/host";
import { invalidate, useResourceEnabled } from "../../../plugin-api/resources";
import { EmptyState, IconChevron, IconClose, IconRefresh, SkeletonRows, Tooltip } from "../../../plugin-api/ui";
import { actionsApi, failureMessage, type Job, type RepoRef, type Run } from "../api";
import { actionsArtifactsR, actionsRunAttemptR, actionsRunR, actionsTimingR } from "../resources";
import {
    elapsedMs,
    failedStep,
    formatAgo,
    formatDuration,
    isRunning,
    jobsSummary,
    outcomeOf,
    OUTCOME_LABEL,
    summaryJobs,
    watchIsNewer,
} from "../runStatus";
import { closeRun, updateView } from "../state";
import { OutcomeIcon } from "./ActionsIcon";
import { Annotations } from "./Annotations";
import { Approvals } from "./Approvals";
import { Artifacts } from "./Artifacts";
import { coarse, useNow } from "./hooks";
import { JobGraph } from "./JobGraph";
import { JobLogView } from "./JobLogView";
import { JobSummary } from "./JobSummary";
import { RunMenu } from "./RunMenu";
import { billedMinutes } from "./RunUsage";
import { WorkflowFile } from "./WorkflowFile";

const WATCH_RETRY_MS = 30_000;

const refreshRuns = () => invalidate((kind) => kind === "gha.runs" || kind === "gha.run");

const StepRow = memo(function StepRow({ step, now, onPick }: { step: Job["steps"][number]; now: number; onPick: (number: number) => void }) {
    const outcome = outcomeOf(step);
    return (
        <button type="button" className="gha-step" data-outcome={outcome} onClick={() => onPick(step.number)} title="Show this step in the log">
            <OutcomeIcon outcome={outcome} size={11} />
            <span className="gha-step-name">{step.name}</span>
            <span className="gha-dim">{formatDuration(elapsedMs(step.startedAt, step.completedAt, now))}</span>
        </button>
    );
});

const JobCard = memo(function JobCard({
    paneId,
    job,
    repo,
    now,
    open,
    active,
    canWrite,
}: {
    paneId: string;
    job: Job;
    repo: RepoRef;
    now: number;
    open: boolean;
    active: boolean;
    canWrite: boolean;
}) {
    const outcome = outcomeOf(job);
    const stopped = failedStep(job);
    const [step, setStep] = useState<{ number: number } | null>(null);
    const rerun = (debug: boolean) =>
        void actionsApi
            .rerunJob(repo, job.id, debug)
            .then(() => {
                notify("success", `Re-running ${job.name}`);
                refreshRuns();
            })
            .catch(reportError(`Could not re-run ${job.name}`));

    return (
        <div className="gha-job" data-open={open ? "1" : "0"} data-outcome={outcome} data-job-id={job.id}>
            <button type="button" className="gha-job-head" onClick={() => updateView(paneId, { job: open ? null : job.id })} aria-expanded={open}>
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
                            {job.steps.map((each) => (
                                <StepRow
                                    key={`${each.number}-${each.name}`}
                                    step={each}
                                    now={each.completedAt ? coarse(now) : now}
                                    onPick={(number) => setStep({ number })}
                                />
                            ))}
                        </div>
                    )}
                    {job.checkRunId !== null && <Annotations repo={repo} checkRunId={job.checkRunId} active={active} />}
                    <JobLogView repo={repo} job={job} active={active} step={step} />
                </div>
            )}
        </div>
    );
});

function Header({
    run,
    repo,
    canWrite,
    onRefresh,
    onDeleted,
}: {
    run: Run;
    repo: RepoRef;
    canWrite: boolean;
    onRefresh: () => void;
    onDeleted: () => void;
}) {
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
                <span className="gha-mono gha-dim">#{run.runNumber}</span>
                <span className="gha-run-head-spacer" />
                {canWrite && live && (
                    <button type="button" className="gha-btn danger" onClick={() => void cancel()}>
                        Cancel run
                    </button>
                )}
                {canWrite && !live && outcome !== "success" && (
                    <button type="button" className="gha-btn" onClick={() => act("Re-running the failed jobs", actionsApi.rerun(repo, run.id, true))}>
                        Re-run failed jobs
                    </button>
                )}
                {canWrite && !live && (
                    <button type="button" className="gha-btn" onClick={() => act("Re-running every job", actionsApi.rerun(repo, run.id, false))}>
                        Re-run all jobs
                    </button>
                )}
                <Tooltip label="Refresh">
                    <button type="button" className="gha-icon-btn" onClick={onRefresh} aria-label="Refresh run">
                        <IconRefresh size={13} />
                    </button>
                </Tooltip>
                <RunMenu run={run} repo={repo} canWrite={canWrite} onDeleted={onDeleted} />
            </div>
            <div className="gha-run-head-sub">
                <span>{run.name}</span>
                {run.attempt > 1 && <span className="gha-dim">attempt {run.attempt}</span>}
            </div>
        </div>
    );
}

const TRIGGER: Record<string, string> = {
    push: "push",
    pull_request: "pull request",
    pull_request_target: "pull request",
    workflow_dispatch: "a manual run",
    schedule: "the schedule",
    release: "a release",
    workflow_run: "another workflow",
    merge_group: "the merge queue",
};

function SummaryCard({
    run,
    repo,
    now,
    active,
    artifactsRef,
}: {
    run: Run;
    repo: RepoRef;
    now: number;
    active: boolean;
    artifactsRef: RefObject<HTMLDivElement | null>;
}) {
    const outcome = outcomeOf(run);
    const live = isRunning(run);
    const artifacts = useResourceEnabled(active && run.status === "completed", actionsArtifactsR, repo, run.id);
    const timing = useResourceEnabled(active && !live, actionsTimingR, repo, run.id);
    const count = artifacts.data?.length ?? 0;
    const billable = timing.data?.billable ?? [];
    const minutes = billedMinutes(billable);
    const took = live ? null : (timing.data?.runDurationMs ?? null);
    return (
        <div className="gha-run-card">
            <div className="gha-run-card-cell gha-run-card-wide">
                <span className="gha-run-card-label">
                    Triggered via {TRIGGER[run.event] ?? run.event.replace(/_/gu, " ")} {formatAgo(run.createdAt, now)}
                </span>
                <span className="gha-run-card-trigger">
                    {run.avatarUrl && <img className="gha-avatar" src={run.avatarUrl} alt="" width={16} height={16} />}
                    {run.actor && <span>{run.actor}</span>}
                    <button
                        type="button"
                        className="gha-link gha-mono"
                        title="Copy the commit"
                        onClick={() =>
                            void copyText(run.sha)
                                .then(() => notify("success", `Copied ${run.shortSha}`))
                                .catch(swallow("copy the commit"))
                        }>
                        {run.shortSha}
                    </button>
                    {run.branch && <span className="gha-branch">{run.branch}</span>}
                    {run.pullRequests.map((number) => (
                        <span key={number} className="gha-pr">
                            #{number}
                        </span>
                    ))}
                </span>
            </div>
            <div className="gha-run-card-cell">
                <span className="gha-run-card-label">Status</span>
                <span className="gha-run-card-value" data-outcome={outcome}>
                    {OUTCOME_LABEL[outcome]}
                </span>
            </div>
            <div className="gha-run-card-cell">
                <span className="gha-run-card-label">Total duration</span>
                <span className="gha-run-card-value">
                    {formatDuration(took ?? elapsedMs(run.startedAt ?? run.createdAt, live ? null : run.updatedAt, now))}
                </span>
            </div>
            {minutes > 0 && (
                <div
                    className="gha-run-card-cell"
                    title={billable.map((each) => `${each.runner}: ${formatDuration(each.totalMs)} over ${each.jobs} jobs`).join("\n")}>
                    <span className="gha-run-card-label">Billed</span>
                    <span className="gha-run-card-value">{minutes} min</span>
                </div>
            )}
            {run.status === "completed" && (
                <div className="gha-run-card-cell">
                    <span className="gha-run-card-label">Artifacts</span>
                    {count > 0 ? (
                        <button
                            type="button"
                            className="gha-link gha-run-card-value"
                            onClick={() => artifactsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}>
                            {count}
                        </button>
                    ) : (
                        <span className="gha-run-card-value">{artifacts.data ? 0 : "—"}</span>
                    )}
                </div>
            )}
        </div>
    );
}

/** Every job's own summary, one after another, the way GitHub's run page lists them. */
function RunSummaries({ repo, jobs, finished, active }: { repo: RepoRef; jobs: Job[]; finished: boolean; active: boolean }) {
    const [everything, setEverything] = useState(false);
    const shown = summaryJobs(jobs, finished, everything);
    const rest = summaryJobs(jobs, finished, true).length - shown.length;
    if (shown.length === 0) return null;
    return (
        <div className="gha-run-summaries">
            {shown.map((job) => (
                <JobSummary key={job.id} repo={repo} checkRunId={job.checkRunId ?? 0} active={active} jobName={job.name} />
            ))}
            {rest > 0 && (
                <button type="button" className="gha-link" onClick={() => setEverything(true)}>
                    Look for summaries from {rest} more job{rest === 1 ? "" : "s"}
                </button>
            )}
        </div>
    );
}

type JobFilter = "all" | "failed";

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
    const [jobFilter, setJobFilter] = useState<JobFilter>("all");
    const detail = useResourceEnabled(active && attempt === null, actionsRunR, repo, runId);
    const older = useResourceEnabled(active && attempt !== null, actionsRunAttemptR, repo, runId, attempt ?? 0);
    const shown = attempt === null ? detail : older;
    const [live, setLive] = useState<{ runId: number; run: Run; jobs: Job[] } | null>(null);
    const [watchRound, setWatchRound] = useState(0);
    const [showFile, setShowFile] = useState(false);
    const viewRef = useRef<HTMLDivElement>(null);
    const artifactsRef = useRef<HTMLDivElement>(null);

    const watched = attempt === null && live?.runId === runId ? live : null;
    const useWatched = watchIsNewer(watched?.run ?? null, shown.data?.run ?? null);
    const run = (useWatched ? watched?.run : shown.data?.run) ?? null;
    const jobs = useWatched && watched?.jobs.length ? watched.jobs : (shown.data?.jobs ?? []);
    const moving = attempt === null && !!run && isRunning(run);
    const latestAttempt = Math.max(detail.data?.run.attempt ?? 0, watched?.run.attempt ?? 0, run?.attempt ?? 0);
    const now = useNow(active && moving);

    // While a run is going, the backend pushes the whole run and its jobs on
    // every tick, and the list behind this view is re-read once it ends.
    useEffect(() => {
        if (!active || !moving) return;
        let streamId: number | null = null;
        let stopped = false;
        void actionsApi
            .watchStart(repo, runId, (tick) => {
                if (stopped) return;
                if (tick.run) setLive({ runId, run: tick.run, jobs: tick.jobs });
                if (!tick.finished) return;
                refreshRuns();
                // A watch that gave up on a run still going is started again a little later.
                if (tick.run && isRunning(tick.run)) setTimeout(() => setWatchRound((round) => round + 1), WATCH_RETRY_MS);
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
    }, [active, moving, repo, runId, watchRound]);

    useEffect(() => setAttempt(null), [runId]);

    const openFromGraph = useCallback(
        (jobId: number) => {
            updateView(paneId, { job: jobId });
            setJobFilter("all");
            requestAnimationFrame(() =>
                viewRef.current?.querySelector(`[data-job-id="${jobId}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" }),
            );
        },
        [paneId],
    );
    const toggleFile = useCallback(() => setShowFile((was) => !was), []);

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
    const listed = jobFilter === "failed" ? jobs.filter((job) => outcomeOf(job) === "failure") : jobs;
    return (
        <div className="gha-run-view" ref={viewRef}>
            <button type="button" className="gha-back" onClick={() => closeRun(paneId)}>
                <IconClose size={11} /> Back to runs
            </button>
            <Header run={run} repo={repo} canWrite={canWrite} onRefresh={() => void shown.refresh()} onDeleted={() => closeRun(paneId)} />
            {latestAttempt > 1 && (
                <div className="gha-attempts">
                    <span className="gha-dim">Attempts</span>
                    {Array.from({ length: latestAttempt }, (_, index) => index + 1).map((number) => (
                        <button
                            key={number}
                            type="button"
                            className="gha-chip"
                            data-on={(attempt ?? latestAttempt) === number ? "1" : "0"}
                            onClick={() => setAttempt(number === latestAttempt ? null : number)}>
                            #{number}
                        </button>
                    ))}
                </div>
            )}
            <SummaryCard run={run} repo={repo} now={now} active={active} artifactsRef={artifactsRef} />
            <Approvals repo={repo} runId={runId} status={run.status} conclusion={run.conclusion} active={active} />
            <JobGraph run={run} jobs={jobs} now={now} openJob={openJob} onOpen={openFromGraph} fileShown={showFile} onToggleFile={toggleFile} />
            {showFile && <WorkflowFile repo={repo} workflowId={run.workflowId} active={active} />}
            <div className="gha-jobs-head">
                {summary.total > 0 ? (
                    <span>
                        {summary.done} of {summary.total} job{summary.total === 1 ? "" : "s"} done
                        {summary.failed > 0 && <span className="gha-failed-count"> · {summary.failed} failed</span>}
                    </span>
                ) : (
                    <span className="gha-dim">No jobs yet</span>
                )}
                {summary.failed > 0 && (
                    <div className="gha-chips">
                        {(["all", "failed"] as const).map((filter) => (
                            <button
                                key={filter}
                                type="button"
                                className="gha-chip"
                                data-on={jobFilter === filter ? "1" : "0"}
                                onClick={() => setJobFilter(filter)}>
                                {filter === "all" ? "All jobs" : "Failed"}
                            </button>
                        ))}
                    </div>
                )}
            </div>
            <div className="gha-jobs">
                {listed.map((job) => (
                    <JobCard
                        key={job.id}
                        paneId={paneId}
                        job={job}
                        repo={repo}
                        now={job.completedAt ? coarse(now) : now}
                        active={active}
                        canWrite={canWrite}
                        open={openJob === job.id}
                    />
                ))}
            </div>
            <RunSummaries repo={repo} jobs={jobs} finished={!isRunning(run)} active={active} />
            <div ref={artifactsRef}>
                <Artifacts repo={repo} runId={runId} active={active && run.status === "completed"} />
            </div>
        </div>
    );
}

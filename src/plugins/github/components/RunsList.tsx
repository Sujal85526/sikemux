import { memo, useEffect } from "react";
import { openUrl, swallow } from "../../../plugin-api/host";
import { useResourceEnabled } from "../../../plugin-api/resources";
import { Dropdown, EmptyState, IconRefresh, IconRun, SkeletonRows, Tooltip } from "../../../plugin-api/ui";
import { failureMessage, type RepoRef, type Run } from "../api";
import { actionsRunsR, actionsWorkflowsR } from "../resources";
import { elapsedMs, formatAgo, formatDuration, isRunning, outcomeOf, statusParam } from "../runStatus";
import { filterBy, showRun, STATUS_FILTERS, updateView, type RunsView, type StatusFilter } from "../state";
import { OutcomeIcon } from "./ActionsIcon";
import { coarse, useNow } from "./hooks";

const LIVE_REFRESH_MS = 10_000;

const FILTER_LABEL: Record<StatusFilter, string> = {
    all: "All",
    in_progress: "Running",
    queued: "Queued",
    success: "Passed",
    failure: "Failed",
    cancelled: "Cancelled",
};

const EVERY_WORKFLOW = "all";

const RunRow = memo(function RunRow({ paneId, run, now, selected }: { paneId: string; run: Run; now: number; selected: boolean }) {
    const outcome = outcomeOf(run);
    const finished = isRunning(run) ? null : run.updatedAt;
    return (
        <button
            type="button"
            className="gha-run-row"
            data-selected={selected ? "1" : "0"}
            data-outcome={outcome}
            onClick={() => showRun(paneId, run.id)}>
            <OutcomeIcon outcome={outcome} />
            <span className="gha-run-title">
                <span className="gha-run-name">{run.title || run.name || `Run #${run.runNumber}`}</span>
                <span className="gha-run-sub">
                    <span className="gha-run-workflow">{run.name}</span>
                    <span>{run.event}</span>
                    {run.branch && <span className="gha-branch">{run.branch}</span>}
                    {run.pullRequests.map((number) => (
                        <span key={number} className="gha-pr">
                            #{number}
                        </span>
                    ))}
                </span>
            </span>
            <span className="gha-run-meta">
                <span className="gha-mono gha-dim">{run.shortSha}</span>
                {run.actor && <span className="gha-dim">{run.actor}</span>}
            </span>
            <span className="gha-run-times">
                <span>{formatDuration(elapsedMs(run.startedAt ?? run.createdAt, finished, now))}</span>
                <span className="gha-dim">{formatAgo(run.createdAt, now)}</span>
            </span>
            <span className="gha-run-number">#{run.runNumber}</span>
        </button>
    );
});

interface Props {
    paneId: string;
    repo: RepoRef;
    view: RunsView;
    branch: string | null;
    active: boolean;
    canWrite: boolean;
    onDispatch: (workflowId: number) => void;
}

export function RunsList({ paneId, repo, view, branch, active, canWrite, onDispatch }: Props) {
    const workflows = useResourceEnabled(active, actionsWorkflowsR, repo);
    const chosen = (workflows.data ?? []).find((workflow) => workflow.id === view.workflowId) ?? null;
    const page = useResourceEnabled(active, actionsRunsR, {
        ...repo,
        workflowId: view.workflowId ?? undefined,
        status: statusParam(view.statusFilter),
        branch: branch ?? undefined,
        page: view.page,
        perPage: 30,
    });
    const runs = page.data?.runs ?? [];
    const anyRunning = runs.some(isRunning);
    const now = useNow(active && anyRunning);

    // A list with something still going is re-read on its own, so a run that
    // finishes stops saying it is running without anybody pressing anything.
    useEffect(() => {
        if (!active || !anyRunning) return;
        const timer = setInterval(() => void page.refresh(), LIVE_REFRESH_MS);
        return () => clearInterval(timer);
    }, [active, anyRunning, page]);

    const nextPage = page.data?.nextPage ?? null;
    const loading = page.status === "loading" && !page.data;
    return (
        <div className="gha-runs">
            <div className="gha-list-head">
                <div className="gha-head-filters">
                    <Dropdown
                        value={view.workflowId === null ? EVERY_WORKFLOW : String(view.workflowId)}
                        options={[
                            { value: EVERY_WORKFLOW, label: "Every workflow" },
                            ...(workflows.data ?? []).map((workflow) => ({
                                value: String(workflow.id),
                                label: workflow.name,
                                detail: workflow.active ? undefined : "off",
                            })),
                        ]}
                        onChange={(value) => filterBy(paneId, { workflowId: value === EVERY_WORKFLOW ? null : Number(value) })}
                        title="Which workflow's runs to show"
                    />
                    <div className="gha-chips">
                        {STATUS_FILTERS.map((filter) => (
                            <button
                                key={filter}
                                type="button"
                                className="gha-chip"
                                data-on={view.statusFilter === filter ? "1" : "0"}
                                onClick={() => filterBy(paneId, { statusFilter: filter })}>
                                {FILTER_LABEL[filter]}
                            </button>
                        ))}
                    </div>
                </div>
                <span className="gha-dim">
                    {page.data?.total ?? runs.length} run{(page.data?.total ?? runs.length) === 1 ? "" : "s"}
                    {branch && <span className="gha-dim"> on {branch}</span>}
                    {canWrite && chosen?.active && (
                        <button type="button" className="gha-link" onClick={() => onDispatch(chosen.id)}>
                            <IconRun size={11} /> Run workflow
                        </button>
                    )}
                    <Tooltip label="Refresh">
                        <button type="button" className="gha-icon-btn" onClick={() => void page.refresh()} aria-label="Refresh runs">
                            <IconRefresh size={13} />
                        </button>
                    </Tooltip>
                </span>
            </div>
            {loading && <SkeletonRows rows={8} label="Loading runs" />}
            {!loading && page.error && (
                <EmptyState
                    title="Could not read runs"
                    message={failureMessage(page.error)}
                    tone="error"
                    action={{ label: "Try again", onClick: () => void page.refresh() }}
                />
            )}
            {!loading && !page.error && runs.length === 0 && (
                <EmptyState title="No runs" message={`Nothing matches this filter${branch ? ` on ${branch}` : ""}.`} />
            )}
            <div className="gha-run-rows">
                {runs.map((run) => (
                    <RunRow key={run.id} paneId={paneId} run={run} now={isRunning(run) ? now : coarse(now)} selected={view.run === run.id} />
                ))}
            </div>
            {runs.length > 0 && (
                <div className="gha-pager">
                    <button type="button" className="gha-btn" disabled={view.page <= 1} onClick={() => updateView(paneId, { page: view.page - 1 })}>
                        Newer
                    </button>
                    <span className="gha-dim">Page {view.page}</span>
                    <button type="button" className="gha-btn" disabled={!nextPage} onClick={() => updateView(paneId, { page: view.page + 1 })}>
                        Older
                    </button>
                    {runs[0] && (
                        <button type="button" className="gha-link" onClick={() => void openUrl(runs[0].url).catch(swallow("open GitHub"))}>
                            Open on GitHub
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}

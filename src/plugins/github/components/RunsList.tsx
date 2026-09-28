import { memo, useEffect, useMemo, useRef } from "react";
import { openUrl, swallow } from "../../../plugin-api/host";
import { useResourceEnabled } from "../../../plugin-api/resources";
import { Dropdown, EmptyState, IconRefresh, IconRun, SkeletonRows, Tooltip } from "../../../plugin-api/ui";
import { failureMessage, type RepoRef, type Run, type Workflow } from "../api";
import { actionsRunsR, actionsWorkflowsR } from "../resources";
import { elapsedMs, formatAgo, formatDuration, isUnfinished, outcomeOf, statusParam } from "../runStatus";
import { filterBy, showRun, STATUS_FILTERS, updateView, type RunsView, type StatusFilter } from "../state";
import { OutcomeIcon } from "./ActionsIcon";
import { Branch } from "./Bits";
import { coarse, useEvery, useNow } from "./hooks";

const LIVE_REFRESH_MS = 10_000;
const IDLE_REFRESH_MS = 20_000;

const FILTER_LABEL: Record<StatusFilter, string> = {
    all: "All",
    in_progress: "Running",
    queued: "Queued",
    success: "Passed",
    failure: "Failed",
    cancelled: "Cancelled",
};

const EVERY_WORKFLOW = "all";

const EVENT_LABEL: Record<string, string> = {
    push: "Push",
    pull_request: "Pull request",
    pull_request_target: "Pull request",
    workflow_dispatch: "Manual",
    schedule: "Scheduled",
    release: "Release",
    workflow_run: "Workflow run",
    merge_group: "Merge queue",
};

function eventLabel(event: string): string {
    const words = event.replace(/_/gu, " ");
    return EVENT_LABEL[event] ?? words.charAt(0).toUpperCase() + words.slice(1);
}

const RunRow = memo(function RunRow({
    paneId,
    run,
    workflow,
    now,
    selected,
}: {
    paneId: string;
    run: Run;
    workflow: string | null;
    now: number;
    selected: boolean;
}) {
    const outcome = outcomeOf(run);
    const finished = isUnfinished(run) ? null : run.updatedAt;
    return (
        <button
            type="button"
            className="gha-run-row"
            data-selected={selected ? "1" : "0"}
            data-outcome={outcome}
            onClick={() => showRun(paneId, run.id)}>
            <OutcomeIcon outcome={outcome} size={12} />
            <span className="gha-run-name">{run.title || run.name || `Run #${run.runNumber}`}</span>
            <span className="gha-run-duration">{formatDuration(elapsedMs(run.startedAt ?? run.createdAt, finished, now))}</span>
            <span className="gha-run-sub">
                <span className="gha-run-workflow">
                    {workflow && `${workflow} `}
                    <span className="gha-item-number">#{run.runNumber}</span>
                </span>
                <span>{eventLabel(run.event)}</span>
                {run.branch && <Branch name={run.branch} />}
                {run.pullRequests.map((number) => (
                    <span key={number} className="gha-item-number">
                        #{number}
                    </span>
                ))}
            </span>
            <span className="gha-run-meta">
                {run.actor && <span className="gha-run-actor">{run.actor}</span>}
                <span className="gha-mono">{run.shortSha}</span>
                <span>{formatAgo(run.createdAt, now)}</span>
            </span>
        </button>
    );
});

function actionsPage(runUrl: string, workflow: Workflow | null): string {
    const actions = runUrl.replace(/\/runs\/\d+.*$/u, "");
    return workflow ? `${actions}/workflows/${workflow.path.split("/").pop()}` : actions;
}

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
    const workflowNames = useMemo(() => new Map((workflows.data ?? []).map((workflow) => [workflow.id, workflow.name])), [workflows.data]);
    const page = useResourceEnabled(active, actionsRunsR, {
        ...repo,
        workflowId: view.workflowId ?? undefined,
        status: statusParam(view.statusFilter),
        branch: branch ?? undefined,
        page: view.page,
        perPage: 30,
    });
    const runs = page.data?.runs ?? [];
    const anyRunning = runs.some(isUnfinished);
    const now = useNow(active && anyRunning);

    useEvery(active, anyRunning ? LIVE_REFRESH_MS : IDLE_REFRESH_MS, () => void page.refresh());

    // A different branch is a different list, so it starts from its first page.
    const shownBranch = useRef(branch);
    useEffect(() => {
        if (shownBranch.current === branch) return;
        shownBranch.current = branch;
        if (view.page !== 1) updateView(paneId, { page: 1, run: null, job: null });
    }, [branch, paneId, view.page]);

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
                    <RunRow
                        key={run.id}
                        paneId={paneId}
                        run={run}
                        workflow={chosen ? null : (workflowNames.get(run.workflowId) ?? null)}
                        now={isUnfinished(run) ? now : coarse(now)}
                        selected={view.run === run.id}
                    />
                ))}
            </div>
            {runs.length > 0 && (
                <div className="gha-pager">
                    {(view.page > 1 || nextPage) && (
                        <>
                            <button
                                type="button"
                                className="gha-btn"
                                disabled={view.page <= 1}
                                onClick={() => updateView(paneId, { page: view.page - 1 })}>
                                Newer
                            </button>
                            <span className="gha-dim">Page {view.page}</span>
                            <button
                                type="button"
                                className="gha-btn"
                                disabled={!nextPage}
                                onClick={() => updateView(paneId, { page: view.page + 1 })}>
                                Older
                            </button>
                        </>
                    )}
                    {runs[0] && (
                        <button
                            type="button"
                            className="gha-link"
                            onClick={() => void openUrl(actionsPage(runs[0].url, chosen)).catch(swallow("open GitHub"))}>
                            Open on GitHub
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}

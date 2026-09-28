import { memo, useEffect, useMemo, useRef } from "react";
import { openUrl, swallow } from "../../plugin-api/host";
import { GitColumns } from "../../components/git/GitColumns";
import { useResourceEnabled } from "../../plugin-api/resources";
import { Dropdown, EmptyState, IconGit, IconRefresh, IconRun, SkeletonRows, Tooltip } from "../../plugin-api/ui";
import { failureMessage, type RepoRef, type Run, type Workflow } from "../api";
import { useHost } from "../registry";
import { runsR, workflowsR } from "../resources";
import { elapsedMs, formatAgo, formatDuration, isUnfinished, outcomeOf, statusParam } from "../runStatus";
import { filterBy, hostSettings, setFollowBranch, showRun, STATUS_FILTERS, updateView, type HostView, type StatusFilter } from "../state";
import { OutcomeIcon } from "./ActionsIcon";
import { Branch, Who } from "./Bits";
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

const RunRow = memo(function RunRow({ paneId, run, workflow, now }: { paneId: string; run: Run; workflow: string | null; now: number }) {
    const outcome = outcomeOf(run);
    const finished = isUnfinished(run) ? null : run.updatedAt;
    return (
        <button type="button" className="gha-run-row" data-outcome={outcome} onClick={() => showRun(paneId, run.id)}>
            <OutcomeIcon outcome={outcome} size={12} />
            <span className="gha-run-name">{run.title || run.name || `Run #${run.runNumber}`}</span>
            <span className="gha-run-duration">{formatDuration(elapsedMs(run.startedAt ?? run.createdAt, finished, now))}</span>
            <span className="gha-run-sub">
                <span className="gha-run-workflow">
                    {workflow && `${workflow} `}
                    <span className="gha-item-number">#{run.runNumber}</span>
                </span>
                {run.branch && <Branch name={run.branch} />}
                {run.pullRequests.map((number) => (
                    <span key={number} className="gha-item-number">
                        #{number}
                    </span>
                ))}
                {run.actor && <Who login={run.actor} avatarUrl={run.avatarUrl} />}
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
    view: HostView;
    /** The branch the list is narrowed to, if any. */
    branch: string | null;
    /** The branch checked out in the git pane, which the list can follow. */
    projectBranch: string | null;
    active: boolean;
    canWrite: boolean;
    onDispatch: (workflowId: number) => void;
}

export function RunsList({ paneId, repo, view, branch, projectBranch, active, canWrite, onDispatch }: Props) {
    const host = useHost();
    const followBranch = hostSettings(repo.provider).useSelect((settings) => settings.followBranch);
    const workflows = useResourceEnabled(active, workflowsR, repo);
    const chosen = (workflows.data ?? []).find((workflow) => workflow.id === view.workflowId) ?? null;
    const workflowNames = useMemo(() => new Map((workflows.data ?? []).map((workflow) => [workflow.id, workflow.name])), [workflows.data]);
    const page = useResourceEnabled(active, runsR, {
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
    const left = (
        <div className="gha-runs pr-list">
            <div className="gha-list-head">
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
                <span className="gha-page-spacer" />
                <span className="gha-dim">
                    {page.data?.total ?? runs.length} run{(page.data?.total ?? runs.length) === 1 ? "" : "s"}
                    {branch && <span className="gha-dim"> on {branch}</span>}
                </span>
                {canWrite && chosen?.active && (
                    <Tooltip label="Run workflow">
                        <button type="button" className="gha-icon-btn" onClick={() => onDispatch(chosen.id)} aria-label="Run workflow">
                            <IconRun size={12} />
                        </button>
                    </Tooltip>
                )}
                <Tooltip label="Refresh">
                    <button type="button" className="gha-icon-btn" onClick={() => void page.refresh()} aria-label="Refresh runs">
                        <IconRefresh size={13} />
                    </button>
                </Tooltip>
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
                    {projectBranch && !view.branch && (
                        <Tooltip label={`Only show runs on ${projectBranch}`}>
                            <button
                                type="button"
                                className="gha-chip"
                                data-on={followBranch ? "1" : "0"}
                                onClick={() => setFollowBranch(repo.provider, !followBranch)}>
                                <IconGit size={11} /> This branch
                            </button>
                        </Tooltip>
                    )}
                </div>
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
                            onClick={() => void openUrl(actionsPage(runs[0].url, chosen)).catch(swallow(`open ${host.name}`))}>
                            Open on {host.name}
                        </button>
                    )}
                </div>
            )}
        </div>
    );

    return (
        <GitColumns
            paneId={paneId}
            left={left}
            right={
                <div className="git-right-review">
                    <EmptyState icon={<IconRun size={20} />} message="Pick a run to see its jobs and logs." />
                </div>
            }
        />
    );
}

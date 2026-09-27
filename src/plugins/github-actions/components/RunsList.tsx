import { useEffect } from "react";
import { openUrl, swallow } from "../../../plugin-api/host";
import { useResourceEnabled } from "../../../plugin-api/resources";
import { EmptyState, IconRefresh, SkeletonRows, Tooltip } from "../../../plugin-api/ui";
import { failureMessage, type RepoRef, type Run } from "../api";
import { actionsRunsR } from "../resources";
import { elapsedMs, formatAgo, formatDuration, isRunning, outcomeOf, statusParam } from "../runStatus";
import { showRun, updateView, type RunsView } from "../state";
import { OutcomeIcon } from "./ActionsIcon";
import { useNow } from "./hooks";

const LIVE_REFRESH_MS = 10_000;

function RunRow({ run, now, selected, onOpen }: { run: Run; now: number; selected: boolean; onOpen: () => void }) {
    const outcome = outcomeOf(run);
    const finished = isRunning(run) ? null : run.updatedAt;
    return (
        <button type="button" className="gha-run-row" data-selected={selected ? "1" : "0"} data-outcome={outcome} onClick={onOpen}>
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
}

interface Props {
    paneId: string;
    repo: RepoRef;
    view: RunsView;
    branch: string | null;
    active: boolean;
}

export function RunsList({ paneId, repo, view, branch, active }: Props) {
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

    if (page.status === "loading" && !page.data) return <SkeletonRows rows={8} label="Loading runs" />;
    if (page.error) {
        return (
            <EmptyState
                title="Could not read runs"
                message={failureMessage(page.error)}
                tone="error"
                action={{ label: "Try again", onClick: () => void page.refresh() }}
            />
        );
    }
    if (runs.length === 0) {
        return <EmptyState title="No runs" message={`Nothing has run here yet${branch ? ` on ${branch}` : ""}.`} />;
    }

    const nextPage = page.data?.nextPage ?? null;
    return (
        <div className="gha-runs">
            <div className="gha-runs-head">
                <span>
                    {page.data?.total ?? runs.length} run{(page.data?.total ?? runs.length) === 1 ? "" : "s"}
                    {branch && <span className="gha-dim"> on {branch}</span>}
                </span>
                <Tooltip label="Refresh">
                    <button type="button" className="gha-icon-btn" onClick={() => void page.refresh()} aria-label="Refresh runs">
                        <IconRefresh size={13} />
                    </button>
                </Tooltip>
            </div>
            <div className="gha-run-rows">
                {runs.map((run) => (
                    <RunRow key={run.id} run={run} now={now} selected={view.run === run.id} onOpen={() => showRun(paneId, run.id)} />
                ))}
            </div>
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
        </div>
    );
}

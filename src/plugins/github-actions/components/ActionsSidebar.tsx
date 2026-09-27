import { useResourceEnabled } from "../../../plugin-api/resources";
import { Checkbox, IconRun, SkeletonRows, Tooltip } from "../../../plugin-api/ui";
import type { RepoRef } from "../api";
import { actionsWorkflowsR } from "../resources";
import { actionsSettings, filterBy, setFollowBranch, slugOf, STATUS_FILTERS, togglePinned, type RunsView, type StatusFilter } from "../state";
import { GithubMark } from "./ActionsIcon";

const FILTER_LABEL: Record<StatusFilter, string> = {
    all: "All",
    in_progress: "Running",
    queued: "Queued",
    success: "Passed",
    failure: "Failed",
    cancelled: "Cancelled",
};

interface Props {
    paneId: string;
    repo: RepoRef;
    view: RunsView;
    projectBranch: string | null;
    active: boolean;
    canWrite: boolean;
    onPickRepo: () => void;
    onDispatch: (workflowId: number) => void;
}

export function ActionsSidebar({ paneId, repo, view, projectBranch, active, canWrite, onPickRepo, onDispatch }: Props) {
    const workflows = useResourceEnabled(active, actionsWorkflowsR, repo);
    const slug = slugOf(repo);
    const pinned = actionsSettings.useSelect((settings) => settings.pinned.includes(slug));
    const followBranch = actionsSettings.useSelect((settings) => settings.followBranch);

    return (
        <div className="gha-side">
            <button type="button" className="gha-repo-button" onClick={onPickRepo} title="Choose a repository">
                <GithubMark size={13} />
                <span className="gha-repo-slug">{slug}</span>
            </button>

            <div className="gha-side-row">
                <button type="button" className="gha-link" onClick={() => togglePinned(slug)}>
                    {pinned ? "Unpin" : "Pin"}
                </button>
                {projectBranch && (
                    <Tooltip label={`Only show runs on ${projectBranch}`}>
                        <span>
                            <Checkbox checked={followBranch} onChange={setFollowBranch}>
                                This branch
                            </Checkbox>
                        </span>
                    </Tooltip>
                )}
            </div>

            <div className="gha-side-section">
                <div className="gha-side-label">Status</div>
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

            <div className="gha-side-section">
                <div className="gha-side-label">Workflows</div>
                {workflows.status === "loading" && !workflows.data && <SkeletonRows rows={4} label="Loading workflows" />}
                <button
                    type="button"
                    className="gha-side-item"
                    data-on={view.workflowId === null ? "1" : "0"}
                    onClick={() => filterBy(paneId, { workflowId: null })}>
                    Every workflow
                </button>
                {(workflows.data ?? []).map((workflow) => (
                    <div className="gha-side-item-row" key={workflow.id}>
                        <button
                            type="button"
                            className="gha-side-item"
                            data-on={view.workflowId === workflow.id ? "1" : "0"}
                            data-off={workflow.active ? "0" : "1"}
                            title={workflow.path}
                            onClick={() => filterBy(paneId, { workflowId: workflow.id })}>
                            {workflow.name}
                        </button>
                        {canWrite && workflow.active && (
                            <Tooltip label={`Run ${workflow.name}`}>
                                <button
                                    type="button"
                                    className="gha-icon-btn"
                                    aria-label={`Run ${workflow.name}`}
                                    onClick={() => onDispatch(workflow.id)}>
                                    <IconRun size={11} />
                                </button>
                            </Tooltip>
                        )}
                    </div>
                ))}
                {workflows.data?.length === 0 && <div className="gha-side-empty">This repository has no workflows.</div>}
            </div>
        </div>
    );
}

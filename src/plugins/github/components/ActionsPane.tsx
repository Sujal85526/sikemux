import { useEffect, useMemo, useState } from "react";
import { notify, reportError } from "../../../plugin-api/host";
import { invalidate, useResourceEnabled } from "../../../plugin-api/resources";
import { EmptyState, SkeletonRows } from "../../../plugin-api/ui";
import { actionsApi } from "../api";
import { useProjectRepo } from "../project";
import { actionsStatusR, actionsWorkflowsR } from "../resources";
import { actionsSettings, needsRepo, refOf, setProjectRepo, showRepo, slugOf, updateView, useRunsView } from "../state";
import { GithubMark } from "./ActionsIcon";
import { ActionsSidebar } from "./ActionsSidebar";
import { ActionsSignIn } from "./ActionsSignIn";
import { DispatchDialog } from "./DispatchDialog";
import { RepoPicker } from "./RepoPicker";
import { InboxView } from "./InboxView";
import { IssuesView } from "./IssuesView";
import { PullsView } from "./PullsView";
import { ReleasesView } from "./ReleasesView";
import { RunsList } from "./RunsList";
import { RunView } from "./RunView";
import "../actions.css";

interface Props {
    paneId: string;
    active: boolean;
}

export function ActionsPane({ paneId, active }: Props) {
    const view = useRunsView(paneId);
    const status = useResourceEnabled(active, actionsStatusR);
    const project = useProjectRepo(active && !!status.data?.ok);
    const lastRepo = actionsSettings.useSelect((settings) => settings.lastRepo);
    const followBranch = actionsSettings.useSelect((settings) => settings.followBranch);
    const [picking, setPicking] = useState(false);

    // The pane follows whichever project is in front, unless somebody has
    // chosen a repository in this pane by hand. Held still between renders so
    // the rows below it are only redrawn when it really changes.
    const repo = useMemo(() => view.repo ?? project.repo ?? (lastRepo ? refOf(lastRepo) : null), [view.repo, project.repo, lastRepo]);

    const workflows = useResourceEnabled(active && !!repo && view.dispatching !== null, actionsWorkflowsR, repo ?? { owner: "", name: "" });
    const dispatching = useMemo(
        () => (view.dispatching === null ? null : (workflows.data ?? []).find((workflow) => workflow.id === view.dispatching)),
        [view.dispatching, workflows.data],
    );

    useEffect(() => {
        if (view.repo || !project.repo) return;
        // Following a project means its runs, not those of whatever was open before.
        showRepo(paneId, project.repo);
    }, [paneId, project.repo, view.repo]);

    const signOut = () =>
        void actionsApi
            .signOut()
            .then(() => {
                notify("success", "Signed out of GitHub");
                invalidate((kind) => kind.startsWith("gha."));
            })
            .catch(reportError("Could not sign out"));

    if (status.status === "loading" && !status.data) {
        return (
            <div className="gha-pane" data-active={active ? "1" : "0"}>
                <SkeletonRows rows={8} label="Connecting to GitHub" />
            </div>
        );
    }

    const signedIn = !!status.data?.ok;
    if (status.data && !signedIn) {
        return (
            <div className="gha-pane" data-active={active ? "1" : "0"}>
                <ActionsSignIn status={status.data} onSignedIn={() => invalidate((kind) => kind.startsWith("gha."))} />
            </div>
        );
    }

    const branch = followBranch && !view.branch ? project.branch : view.branch;

    return (
        <div className="gha-pane" data-active={active ? "1" : "0"}>
            <div className="gha-top">
                <span className="gha-who">
                    <GithubMark size={13} />
                    <strong>{status.data?.login}</strong>
                    <span className="gha-dim">on {status.data?.host}</span>
                </span>
                {status.data && !status.data.canWriteWorkflows && (
                    <span className="gha-warn-note">This token cannot start or re-run workflows — it is missing the workflow scope.</span>
                )}
                <span className="gha-top-spacer" />
                <button type="button" className="gha-link" onClick={signOut}>
                    Sign out
                </button>
            </div>

            <div className="gha-cols">
                <ActionsSidebar
                    paneId={paneId}
                    repo={repo ?? { owner: "", name: "" }}
                    view={view}
                    projectBranch={project.branch}
                    onPickRepo={() => setPicking(true)}
                />
                <div className="gha-body">
                    {!needsRepo(view.section) ? (
                        <InboxView active={active} />
                    ) : !repo ? (
                        project.loading ? (
                            <SkeletonRows rows={4} label="Finding this project's repository" />
                        ) : (
                            <EmptyState
                                title="No repository yet"
                                message={
                                    project.cwd
                                        ? "This project's git remote is not a repository on this GitHub. Choose one to watch."
                                        : "Open a project, or choose a repository to watch."
                                }
                                action={{ label: "Choose a repository", onClick: () => setPicking(true) }}
                            />
                        )
                    ) : view.section === "pulls" ? (
                        <PullsView paneId={paneId} repo={repo} listState={view.listState} item={view.item} active={active} />
                    ) : view.section === "issues" ? (
                        <IssuesView paneId={paneId} repo={repo} listState={view.listState} item={view.item} active={active} />
                    ) : view.section === "releases" ? (
                        <ReleasesView repo={repo} active={active} />
                    ) : view.run === null ? (
                        <RunsList
                            paneId={paneId}
                            repo={repo}
                            view={view}
                            branch={branch}
                            active={active}
                            canWrite={!!status.data?.canWriteWorkflows}
                            onDispatch={(workflowId) => updateView(paneId, { dispatching: workflowId })}
                        />
                    ) : (
                        <RunView
                            paneId={paneId}
                            repo={repo}
                            runId={view.run}
                            openJob={view.job}
                            active={active}
                            canWrite={!!status.data?.canWriteWorkflows}
                        />
                    )}
                </div>
            </div>

            {picking && (
                <RepoPicker
                    current={repo}
                    onClose={() => setPicking(false)}
                    onPick={(picked) => {
                        showRepo(paneId, picked);
                        // A repository chosen while a project is in front belongs
                        // to that project, so it comes back with it.
                        if (project.cwd) setProjectRepo(project.cwd, slugOf(picked));
                    }}
                />
            )}
            {repo && dispatching && (
                <DispatchDialog
                    repo={repo}
                    workflow={dispatching}
                    defaultBranch={branch ?? project.branch}
                    onClose={() => updateView(paneId, { dispatching: null })}
                />
            )}
        </div>
    );
}

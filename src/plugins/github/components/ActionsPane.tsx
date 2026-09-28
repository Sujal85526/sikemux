import { useEffect, useMemo, useState } from "react";
import { notify, reportError } from "../../../plugin-api/host";
import { invalidate, useResourceEnabled } from "../../../plugin-api/resources";
import { EmptyState, SkeletonRows } from "../../../plugin-api/ui";
import { actionsApi } from "../api";
import { useProjectRepo, useShownRepo } from "../project";
import { actionsStatusR, actionsWorkflowsR } from "../resources";
import { actionsSettings, needsRepo, pickRepo, refOf, showRepo, slugOf, updateView, useRunsView, viewOf } from "../state";
import { GithubMark } from "./ActionsIcon";
import { useBusy } from "./hooks";
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
    const followBranch = actionsSettings.useSelect((settings) => settings.followBranch);
    const [picking, setPicking] = useState(false);
    const [signingOut, runSignOut] = useBusy();

    const repo = useShownRepo(view.repo, project.repo);

    const workflows = useResourceEnabled(active && !!repo && view.dispatching !== null, actionsWorkflowsR, repo ?? { owner: "", name: "" });
    const dispatching = useMemo(
        () => (view.dispatching === null ? null : (workflows.data ?? []).find((workflow) => workflow.id === view.dispatching)),
        [view.dispatching, workflows.data],
    );

    // The pane follows the project in front, and shows that project's repository.
    const projectSlug = project.repo ? slugOf(project.repo) : null;
    useEffect(() => {
        const next = projectSlug ? refOf(projectSlug) : null;
        if (!next) return;
        const current = viewOf(paneId).repo;
        if (current && slugOf(current) === projectSlug) return;
        const remembered = actionsSettings.get().lastRepo;
        showRepo(paneId, next, current ?? (remembered ? refOf(remembered) : null));
    }, [paneId, projectSlug]);

    const signOut = () =>
        runSignOut(() =>
            actionsApi
                .signOut()
                .then(() => {
                    notify("success", "Signed out of GitHub");
                    invalidate((kind) => kind.startsWith("gha."));
                })
                .catch(reportError("Could not sign out")),
        );

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

    // The project's branch means nothing on a repository that is not the project's.
    const projectBranch = project.repo && repo && slugOf(project.repo) === slugOf(repo) ? project.branch : null;
    const branch = followBranch && !view.branch ? projectBranch : view.branch;

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
                <button type="button" className="gha-link" disabled={signingOut} onClick={signOut}>
                    Sign out
                </button>
            </div>

            <div className="gha-cols">
                <ActionsSidebar
                    paneId={paneId}
                    repo={repo ?? { owner: "", name: "" }}
                    view={view}
                    projectBranch={projectBranch}
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
                        <PullsView
                            paneId={paneId}
                            repo={repo}
                            listState={view.listState}
                            item={view.item}
                            composing={view.composing === "pull"}
                            projectBranch={projectBranch}
                            login={status.data?.login ?? null}
                            active={active}
                        />
                    ) : view.section === "issues" ? (
                        <IssuesView
                            paneId={paneId}
                            repo={repo}
                            listState={view.listState}
                            item={view.item}
                            composing={view.composing === "issue"}
                            page={view.page}
                            active={active}
                        />
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
                    onPick={(picked) => pickRepo(paneId, picked, { cwd: project.cwd, shown: repo })}
                />
            )}
            {repo && dispatching && (
                <DispatchDialog
                    repo={repo}
                    workflow={dispatching}
                    defaultBranch={branch ?? projectBranch}
                    onClose={() => updateView(paneId, { dispatching: null })}
                />
            )}
        </div>
    );
}

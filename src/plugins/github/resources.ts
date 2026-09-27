import { resource } from "../../plugin-api/resources";
import {
    actionsApi,
    type Annotation,
    type ChangedFile,
    type Comment,
    type Issue,
    type Notification,
    type Pull,
    type Release,
    type Review,
    type Artifact,
    type PendingApproval,
    type ActionsStatus,
    type JobLog,
    type RepoListing,
    type RepoRef,
    type Resolved,
    type RunDetail,
    type RunPage,
    type RunQuery,
    type Workflow,
} from "./api";

export const actionsStatusR = resource({
    kind: "gha.status",
    fetch: (): Promise<ActionsStatus> => actionsApi.status(),
    staleAfterMs: 60_000,
});

export const actionsRemoteR = resource({
    kind: "gha.remote",
    fetch: (url: string): Promise<Resolved> => actionsApi.resolveRemote(url),
    staleAfterMs: 5 * 60_000,
});

export const actionsMyReposR = resource({
    kind: "gha.myRepos",
    fetch: (): Promise<RepoListing[]> => actionsApi.myRepos(),
    staleAfterMs: 5 * 60_000,
});

export const actionsWorkflowsR = resource({
    kind: "gha.workflows",
    fetch: (repo: RepoRef): Promise<Workflow[]> => actionsApi.workflows(repo),
    staleAfterMs: 5 * 60_000,
});

export const actionsBranchesR = resource({
    kind: "gha.branches",
    fetch: (repo: RepoRef): Promise<string[]> => actionsApi.branches(repo),
    staleAfterMs: 5 * 60_000,
});

export const actionsRunsR = resource({
    kind: "gha.runs",
    fetch: (query: RunQuery): Promise<RunPage> => actionsApi.runs(query),
    staleAfterMs: 15_000,
});

export const actionsRunR = resource({
    kind: "gha.run",
    fetch: (repo: RepoRef, runId: number): Promise<RunDetail> => actionsApi.run(repo, runId),
    staleAfterMs: 10_000,
});

export const actionsAnnotationsR = resource({
    kind: "gha.annotations",
    fetch: (repo: RepoRef, checkRunId: number): Promise<Annotation[]> => actionsApi.annotations(repo, checkRunId),
    staleAfterMs: 60_000,
});

export const actionsArtifactsR = resource({
    kind: "gha.artifacts",
    fetch: (repo: RepoRef, runId: number): Promise<Artifact[]> => actionsApi.artifacts(repo, runId),
    staleAfterMs: 60_000,
});

export const actionsApprovalsR = resource({
    kind: "gha.approvals",
    fetch: (repo: RepoRef, runId: number): Promise<PendingApproval[]> => actionsApi.pendingApprovals(repo, runId),
    staleAfterMs: 15_000,
});

export const actionsRunAttemptR = resource({
    kind: "gha.runAttempt",
    fetch: (repo: RepoRef, runId: number, attempt: number): Promise<RunDetail> => actionsApi.runAttempt(repo, runId, attempt),
    staleAfterMs: 5 * 60_000,
});

export const githubPullsR = resource({
    kind: "gha.pulls",
    fetch: (repo: RepoRef, state: string): Promise<Pull[]> => actionsApi.pulls(repo, state),
    staleAfterMs: 60_000,
});

export const githubPullR = resource({
    kind: "gha.pull",
    fetch: (repo: RepoRef, number: number): Promise<Pull> => actionsApi.pull(repo, number),
    staleAfterMs: 30_000,
});

export const githubPullFilesR = resource({
    kind: "gha.pullFiles",
    fetch: (repo: RepoRef, number: number): Promise<ChangedFile[]> => actionsApi.pullFiles(repo, number),
    staleAfterMs: 5 * 60_000,
});

export const githubPullReviewsR = resource({
    kind: "gha.pullReviews",
    fetch: (repo: RepoRef, number: number): Promise<Review[]> => actionsApi.pullReviews(repo, number),
    staleAfterMs: 60_000,
});

export const githubIssuesR = resource({
    kind: "gha.issues",
    fetch: (repo: RepoRef, state: string): Promise<Issue[]> => actionsApi.issues(repo, state),
    staleAfterMs: 60_000,
});

export const githubIssueR = resource({
    kind: "gha.issue",
    fetch: (repo: RepoRef, number: number): Promise<Issue> => actionsApi.issue(repo, number),
    staleAfterMs: 30_000,
});

export const githubCommentsR = resource({
    kind: "gha.comments",
    fetch: (repo: RepoRef, number: number): Promise<Comment[]> => actionsApi.comments(repo, number),
    staleAfterMs: 30_000,
});

export const githubReleasesR = resource({
    kind: "gha.releases",
    fetch: (repo: RepoRef): Promise<Release[]> => actionsApi.releases(repo),
    staleAfterMs: 5 * 60_000,
});

export const githubInboxR = resource({
    kind: "gha.inbox",
    fetch: (all: boolean): Promise<Notification[]> => actionsApi.inbox(all),
    staleAfterMs: 30_000,
});

export const actionsJobLogR = resource({
    kind: "gha.jobLog",
    fetch: (repo: RepoRef, jobId: number): Promise<JobLog> => actionsApi.jobLog(repo, jobId),
    staleAfterMs: 30_000,
});

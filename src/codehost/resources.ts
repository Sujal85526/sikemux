import { resource } from "../plugin-api/resources";
import {
    type Annotation,
    type JobSummary,
    type RunTiming,
    type WorkflowFile,
    type ChangedFile,
    type Comment,
    type Issue,
    type IssuePage,
    type Notification,
    type Pull,
    type PullCommit,
    type CommitAuthor,
    type TimelineItem,
    type Release,
    type Review,
    type Artifact,
    type PendingApproval,
    type JobLog,
    type RepoListing,
    type RepoRef,
    type Resolved,
    type RunDetail,
    type RunPage,
    type RunQuery,
    type Workflow,
} from "./types";
import { hostApi, type HostAccount } from "./registry";

export const hostStatusR = resource({
    kind: "host.status",
    fetch: (provider: string): Promise<HostAccount> => hostApi(provider).status(),
    staleAfterMs: 60_000,
});

export const hostRemoteR = resource({
    kind: "host.remote",
    fetch: (provider: string, url: string): Promise<Resolved> => hostApi(provider).resolveRemote(url),
    staleAfterMs: 5 * 60_000,
});

export const myReposR = resource({
    kind: "host.myRepos",
    fetch: (provider: string): Promise<RepoListing[]> => hostApi(provider).myRepos(),
    staleAfterMs: 5 * 60_000,
});

export const workflowsR = resource({
    kind: "host.workflows",
    fetch: (repo: RepoRef): Promise<Workflow[]> => hostApi(repo.provider).workflows(repo),
    staleAfterMs: 5 * 60_000,
});

export const hostBranchesR = resource({
    kind: "host.branches",
    fetch: (repo: RepoRef): Promise<string[]> => hostApi(repo.provider).branches(repo),
    staleAfterMs: 5 * 60_000,
});

export const runsR = resource({
    kind: "host.runs",
    fetch: (query: RunQuery): Promise<RunPage> => hostApi(query.provider).runs(query),
    staleAfterMs: 15_000,
});

export const runR = resource({
    kind: "host.run",
    fetch: (repo: RepoRef, runId: number): Promise<RunDetail> => hostApi(repo.provider).run(repo, runId),
    staleAfterMs: 10_000,
});

export const annotationsR = resource({
    kind: "host.annotations",
    fetch: (repo: RepoRef, checkRunId: number): Promise<Annotation[]> => hostApi(repo.provider).annotations(repo, checkRunId),
    staleAfterMs: 60_000,
});

export const jobSummaryR = resource({
    kind: "host.jobSummary",
    fetch: (repo: RepoRef, checkRunId: number): Promise<JobSummary | null> => hostApi(repo.provider).jobSummary(repo, checkRunId),
    staleAfterMs: 5 * 60_000,
});

export const timingR = resource({
    kind: "host.timing",
    fetch: (repo: RepoRef, runId: number): Promise<RunTiming> => hostApi(repo.provider).runTiming(repo, runId),
    staleAfterMs: 5 * 60_000,
});

export const workflowFileR = resource({
    kind: "host.workflowFile",
    fetch: (repo: RepoRef, workflowId: number): Promise<WorkflowFile> => hostApi(repo.provider).workflowFile(repo, workflowId),
    staleAfterMs: 10 * 60_000,
});

export const artifactsR = resource({
    kind: "host.artifacts",
    fetch: (repo: RepoRef, runId: number): Promise<Artifact[]> => hostApi(repo.provider).artifacts(repo, runId),
    staleAfterMs: 60_000,
});

export const approvalsR = resource({
    kind: "host.approvals",
    fetch: (repo: RepoRef, runId: number): Promise<PendingApproval[]> => hostApi(repo.provider).pendingApprovals(repo, runId),
    staleAfterMs: 15_000,
});

export const runAttemptR = resource({
    kind: "host.runAttempt",
    fetch: (repo: RepoRef, runId: number, attempt: number): Promise<RunDetail> => hostApi(repo.provider).runAttempt(repo, runId, attempt),
    staleAfterMs: 5 * 60_000,
});

export const pullsR = resource({
    kind: "host.pulls",
    fetch: (repo: RepoRef, state: string): Promise<Pull[]> => hostApi(repo.provider).pulls(repo, state),
    staleAfterMs: 60_000,
});

export const pullR = resource({
    kind: "host.pull",
    fetch: (repo: RepoRef, number: number): Promise<Pull> => hostApi(repo.provider).pull(repo, number),
    staleAfterMs: 30_000,
});

export const pullFilesR = resource({
    kind: "host.pullFiles",
    fetch: (repo: RepoRef, number: number): Promise<ChangedFile[]> => hostApi(repo.provider).pullFiles(repo, number),
    staleAfterMs: 5 * 60_000,
});

export const timelineR = resource({
    kind: "host.timeline",
    fetch: (repo: RepoRef, number: number): Promise<TimelineItem[]> => hostApi(repo.provider).timeline(repo, number),
    staleAfterMs: 30_000,
});

export const pullCommitsR = resource({
    kind: "host.pullCommits",
    fetch: (repo: RepoRef, number: number): Promise<PullCommit[]> => hostApi(repo.provider).pullCommits(repo, number),
    staleAfterMs: 60_000,
});

export const commitAuthorsR = resource({
    kind: "host.commitAuthors",
    fetch: (repo: RepoRef, gitRef: string | null): Promise<CommitAuthor[]> =>
        hostApi(repo.provider).commitAuthors?.(repo, gitRef) ?? Promise.resolve([]),
    staleAfterMs: 10 * 60_000,
});

export const pullReviewsR = resource({
    kind: "host.pullReviews",
    fetch: (repo: RepoRef, number: number): Promise<Review[]> => hostApi(repo.provider).pullReviews(repo, number),
    staleAfterMs: 60_000,
});

export const issuesR = resource({
    kind: "host.issues",
    fetch: (repo: RepoRef, state: string, page: number): Promise<IssuePage> => hostApi(repo.provider).issues(repo, state, page),
    staleAfterMs: 60_000,
});

export const issueR = resource({
    kind: "host.issue",
    fetch: (repo: RepoRef, number: number): Promise<Issue> => hostApi(repo.provider).issue(repo, number),
    staleAfterMs: 30_000,
});

export const commentsR = resource({
    kind: "host.comments",
    fetch: (repo: RepoRef, number: number): Promise<Comment[]> => hostApi(repo.provider).comments(repo, number),
    staleAfterMs: 30_000,
});

export const releasesR = resource({
    kind: "host.releases",
    fetch: (repo: RepoRef): Promise<Release[]> => hostApi(repo.provider).releases(repo),
    staleAfterMs: 5 * 60_000,
});

export const inboxR = resource({
    kind: "host.inbox",
    fetch: (provider: string, all: boolean): Promise<Notification[]> => hostApi(provider).inbox(all),
    staleAfterMs: 30_000,
});

export const jobLogR = resource({
    kind: "host.jobLog",
    fetch: (repo: RepoRef, jobId: number): Promise<JobLog> => hostApi(repo.provider).jobLog(repo, jobId),
    staleAfterMs: 30_000,
});

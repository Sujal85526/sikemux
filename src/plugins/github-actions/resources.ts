import { resource } from "../../plugin-api/resources";
import {
    actionsApi,
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

export const actionsJobLogR = resource({
    kind: "gha.jobLog",
    fetch: (repo: RepoRef, jobId: number): Promise<JobLog> => actionsApi.jobLog(repo, jobId),
    staleAfterMs: 30_000,
});

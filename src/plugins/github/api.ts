import { createPluginBackend, isPluginFailure } from "../../plugin-api/backend";
import { invalidate } from "../../plugin-api/resources";
import { GITHUB_PLUGIN_ID } from "./kinds";

const backend = createPluginBackend(GITHUB_PLUGIN_ID);

export type TokenSource = "keychain" | "environment" | "ghCli";

export interface ActionsStatus {
    configured: boolean;
    host: string;
    login: string;
    tokenSource: TokenSource | null;
    scopes: string[];
    canWriteWorkflows: boolean;
    ok: boolean;
    authFailed: boolean;
    message: string | null;
}

export interface Repo {
    host: string;
    owner: string;
    name: string;
}

export interface Resolved {
    repo: Repo | null;
    slug: string | null;
    sameHost: boolean;
}

export interface RepoListing {
    owner: string;
    name: string;
    slug: string;
    private: boolean;
    archived: boolean;
    defaultBranch: string | null;
    pushedAt: string | null;
    url: string;
}

/** Which repository a call is about. Every read and write carries one. */
export interface RepoRef {
    owner: string;
    name: string;
}

export interface Workflow {
    id: number;
    name: string;
    path: string;
    state: string;
    active: boolean;
    url: string;
}

export type RunStatus =
    | "queued"
    | "in_progress"
    | "completed"
    | "requested"
    | "waiting"
    | "pending"
    | "success"
    | "failure"
    | "neutral"
    | "cancelled"
    | "skipped"
    | "timed_out"
    | "action_required";

export interface Run {
    id: number;
    name: string;
    title: string;
    workflowId: number;
    runNumber: number;
    attempt: number;
    event: string;
    status: string;
    conclusion: string | null;
    branch: string | null;
    sha: string;
    shortSha: string;
    actor: string | null;
    avatarUrl: string | null;
    createdAt: string;
    startedAt: string | null;
    updatedAt: string;
    pullRequests: number[];
    url: string;
}

export interface RunQuery extends RepoRef {
    workflowId?: number;
    branch?: string;
    status?: RunStatus;
    event?: string;
    actor?: string;
    page?: number;
    perPage?: number;
}

export interface RunPage {
    runs: Run[];
    total: number;
    nextPage: number | null;
}

export interface Step {
    number: number;
    name: string;
    status: string;
    conclusion: string | null;
    startedAt: string | null;
    completedAt: string | null;
}

export interface Job {
    id: number;
    name: string;
    status: string;
    conclusion: string | null;
    startedAt: string | null;
    completedAt: string | null;
    runner: string | null;
    url: string | null;
    /** Where this job's annotations live; absent on a job GitHub never checked. */
    checkRunId: number | null;
    steps: Step[];
}

export interface RunDetail {
    run: Run;
    jobs: Job[];
}

export interface LogLine {
    number: number;
    timestamp: string | null;
    text: string;
}

export interface JobLog {
    lines: LogLine[];
    expired: boolean;
}

export interface Annotation {
    path: string | null;
    startLine: number | null;
    endLine: number | null;
    /** `failure`, `warning` or `notice`. */
    level: string;
    title: string | null;
    message: string;
    details: string | null;
}

export interface Artifact {
    id: number;
    name: string;
    sizeBytes: number;
    expired: boolean;
    createdAt: string | null;
    expiresAt: string | null;
}

export interface SavedArtifact {
    path: string;
    bytes: number;
}

export interface PendingApproval {
    environmentId: number;
    environment: string;
    waitMinutes: number;
    canApprove: boolean;
    reviewers: string[];
}

export interface RunTick {
    run: Run | null;
    jobs: Job[];
    error: string | null;
    finished: boolean;
}

export function failureMessage(error: unknown): string {
    return isPluginFailure(error) ? error.message : String(error);
}

function isSignedOut(error: unknown): boolean {
    if (!isPluginFailure(error)) return false;
    return error.category === "auth" || error.category === "unconfigured" || (error.category === "http" && error.status === 401);
}

/** A token GitHub has stopped accepting makes every cached answer stale, so the next read lands on the sign-in form. */
async function read<T>(method: string, params?: unknown): Promise<T> {
    try {
        return await backend.call<T>(method, params);
    } catch (error) {
        if (isSignedOut(error)) invalidate((kind) => kind.startsWith("gha."));
        throw error;
    }
}

export const actionsApi = {
    status: () => backend.call<ActionsStatus>("status"),
    signIn: (host: string, token?: string) => backend.call<ActionsStatus>("signIn", { host, token }),
    signOut: () => backend.call<void>("signOut"),

    resolveRemote: (url: string) => backend.call<Resolved>("resolveRemote", { url }),
    myRepos: (limit = 50) => read<RepoListing[]>("myRepos", { limit }),

    workflows: (repo: RepoRef) => read<Workflow[]>("workflows", repo),
    branches: (repo: RepoRef) => read<string[]>("branches", repo),
    runs: (query: RunQuery) => read<RunPage>("runs", query),
    run: (repo: RepoRef, runId: number) => read<RunDetail>("run", { ...repo, runId }),
    jobLog: (repo: RepoRef, jobId: number) => read<JobLog>("jobLog", { ...repo, jobId }),
    annotations: (repo: RepoRef, checkRunId: number) => read<Annotation[]>("annotations", { ...repo, checkRunId }),
    artifacts: (repo: RepoRef, runId: number) => read<Artifact[]>("artifacts", { ...repo, runId }),
    pendingApprovals: (repo: RepoRef, runId: number) => read<PendingApproval[]>("pendingApprovals", { ...repo, runId }),
    runAttempt: (repo: RepoRef, runId: number, attempt: number) => read<RunDetail>("runAttempt", { ...repo, runId, attempt }),

    dispatch: (repo: RepoRef, workflowId: number, gitRef: string, inputs: Record<string, string>) =>
        backend.call<void>("dispatch", { ...repo, workflowId, gitRef, inputs }),
    rerun: (repo: RepoRef, runId: number, failedOnly: boolean, debug = false) => backend.call<void>("rerun", { ...repo, runId, failedOnly, debug }),
    rerunJob: (repo: RepoRef, jobId: number, debug = false) => backend.call<void>("rerunJob", { ...repo, jobId, debug }),
    cancel: (repo: RepoRef, runId: number) => backend.call<void>("cancel", { ...repo, runId }),
    downloadArtifact: (repo: RepoRef, artifactId: number, name: string) =>
        backend.call<SavedArtifact>("downloadArtifact", { ...repo, artifactId, name }),
    reviewDeployment: (repo: RepoRef, runId: number, environmentIds: number[], state: "approved" | "rejected", comment = "") =>
        backend.call<void>("reviewDeployment", { ...repo, runId, environmentIds, state, comment }),
    setWorkflowEnabled: (repo: RepoRef, workflowId: number, enabled: boolean) =>
        backend.call<void>("setWorkflowEnabled", { ...repo, workflowId, enabled }),

    watchStart: (repo: RepoRef, runId: number, onTick: (tick: RunTick) => void) =>
        backend.openStream<RunTick>("watchRun", { ...repo, runId }, onTick),
    watchStop: (streamId: number) => backend.closeStream(streamId),
};

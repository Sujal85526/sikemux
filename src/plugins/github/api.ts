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
    path: string | null;
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
    headSha?: string;
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
    /** The log was longer than 16 MiB, so `lines` holds only its last 16 MiB. */
    truncated: boolean;
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

export interface JobSummary {
    title: string;
    body: string;
}

export interface Billable {
    runner: string;
    totalMs: number;
    jobs: number;
}

export interface RunTiming {
    runDurationMs: number | null;
    billable: Billable[];
}

export interface WorkflowFile {
    path: string;
    text: string;
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

/** How far a download has got. `total` is unknown when GitHub did not say. */
export interface DownloadProgress {
    received: number;
    total: number | null;
}

interface DownloadTick extends DownloadProgress {
    saved: SavedArtifact | null;
}

/** Files can take longer than any single call may, so they arrive as a stream of progress that ends where the file was saved. */
function download(method: string, params: unknown, onProgress?: (progress: DownloadProgress) => void): Promise<SavedArtifact> {
    return new Promise((resolve, reject) => {
        let saved: SavedArtifact | null = null;
        backend.stream<DownloadTick>(method, params, {
            onItem: (tick) => {
                if (tick.saved) saved = tick.saved;
                else onProgress?.(tick);
            },
            onEnd: () => (saved ? resolve(saved) : reject(new Error("the download ended without saving anything"))),
            onError: reject,
        });
    });
}

export interface PendingApproval {
    environmentId: number;
    environment: string;
    waitMinutes: number;
    canApprove: boolean;
    reviewers: string[];
}

/**
 * One read of a watched run. `run` and `jobs` are the last ones read, so a tick whose read failed still carries them
 * (both are empty only if no read has worked yet). `error` says why this read failed. `finished` is the last tick:
 * with no error the run is over; with one the watch gave up, at once when signed out or the run is gone, or after
 * repeated failures.
 */
export interface RunTick {
    run: Run | null;
    jobs: Job[];
    error: string | null;
    finished: boolean;
}

export interface Label {
    name: string;
    color: string;
}

export interface Comment {
    id: number;
    author: string | null;
    avatarUrl: string | null;
    body: string;
    createdAt: string;
    url: string | null;
}

export type PullState = "open" | "closed" | "merged";

export interface Pull {
    number: number;
    title: string;
    body: string;
    state: string;
    draft: boolean;
    author: string | null;
    avatarUrl: string | null;
    head: string | null;
    base: string | null;
    headSha: string | null;
    createdAt: string;
    updatedAt: string;
    /** Unknown when GitHub did not say. */
    comments: number | null;
    additions: number | null;
    deletions: number | null;
    changedFiles: number | null;
    mergeable: boolean | null;
    mergeState: string | null;
    labels: Label[];
    reviewers: string[];
    url: string;
}

export interface ChangedFile {
    path: string;
    status: string;
    additions: number;
    deletions: number;
    previousPath: string | null;
    patch: string | null;
}

export interface Review {
    author: string | null;
    state: string;
    body: string;
    submittedAt: string | null;
}

export type MergeMethod = "merge" | "squash" | "rebase";

export type ReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

export interface NewPull {
    title: string;
    head: string;
    base: string;
    body: string;
    draft: boolean;
}

export interface Issue {
    number: number;
    title: string;
    body: string;
    state: string;
    author: string | null;
    avatarUrl: string | null;
    createdAt: string;
    updatedAt: string;
    closedAt: string | null;
    comments: number;
    labels: Label[];
    assignees: string[];
    url: string;
}

export interface IssuePage {
    issues: Issue[];
    total: number;
    nextPage: number | null;
}

export interface ReleaseAsset {
    id: number;
    name: string;
    sizeBytes: number;
    downloads: number;
}

export interface Release {
    id: number;
    tag: string;
    name: string;
    body: string;
    draft: boolean;
    prerelease: boolean;
    publishedAt: string | null;
    author: string | null;
    assets: ReleaseAsset[];
    url: string;
}

export interface Notification {
    id: string;
    title: string;
    kind: string;
    reason: string;
    repo: string;
    number: number | null;
    unread: boolean;
    updatedAt: string;
    url: string | null;
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
    jobSummary: (repo: RepoRef, checkRunId: number) => read<JobSummary | null>("jobSummary", { ...repo, checkRunId }),
    runTiming: (repo: RepoRef, runId: number) => read<RunTiming>("runTiming", { ...repo, runId }),
    workflowFile: (repo: RepoRef, workflowId: number) => read<WorkflowFile>("workflowFile", { ...repo, workflowId }),
    artifacts: (repo: RepoRef, runId: number) => read<Artifact[]>("artifacts", { ...repo, runId }),
    pendingApprovals: (repo: RepoRef, runId: number) => read<PendingApproval[]>("pendingApprovals", { ...repo, runId }),
    runAttempt: (repo: RepoRef, runId: number, attempt: number) => read<RunDetail>("runAttempt", { ...repo, runId, attempt }),

    pulls: (repo: RepoRef, state: string) => read<Pull[]>("pulls", { ...repo, state }),
    pull: (repo: RepoRef, number: number) => read<Pull>("pull", { ...repo, number }),
    pullFiles: (repo: RepoRef, number: number) => read<ChangedFile[]>("pullFiles", { ...repo, number }),
    pullReviews: (repo: RepoRef, number: number) => read<Review[]>("pullReviews", { ...repo, number }),
    issues: (repo: RepoRef, state: string, page: number) => read<IssuePage>("issues", { ...repo, state, page }),
    issue: (repo: RepoRef, number: number) => read<Issue>("issue", { ...repo, number }),
    comments: (repo: RepoRef, number: number) => read<Comment[]>("comments", { ...repo, number }),
    releases: (repo: RepoRef) => read<Release[]>("releases", repo),
    inbox: (all: boolean) => read<Notification[]>("inbox", { all }),

    mergePull: (repo: RepoRef, number: number, method: MergeMethod) => backend.call<void>("mergePull", { ...repo, number, method }),
    createPull: (repo: RepoRef, pull: NewPull) => backend.call<Pull>("createPull", { ...repo, ...pull }),
    setPullState: (repo: RepoRef, number: number, state: "open" | "closed") => backend.call<void>("setPullState", { ...repo, number, state }),
    reviewPull: (repo: RepoRef, number: number, event: ReviewEvent, body: string) =>
        backend.call<void>("reviewPull", { ...repo, number, event, body }),
    createIssue: (repo: RepoRef, title: string, body: string) => backend.call<Issue>("createIssue", { ...repo, title, body }),
    setIssueState: (repo: RepoRef, number: number, state: "open" | "closed") => backend.call<void>("setIssueState", { ...repo, number, state }),
    addComment: (repo: RepoRef, number: number, body: string) => backend.call<void>("addComment", { ...repo, number, body }),
    downloadAsset: (repo: RepoRef, assetId: number, name: string, onProgress?: (progress: DownloadProgress) => void) =>
        download("downloadAsset", { ...repo, assetId, fileName: name }, onProgress),
    markRead: (id: string) => backend.call<void>("markRead", { id }),
    markAllRead: () => backend.call<void>("markAllRead"),

    dispatch: (repo: RepoRef, workflowId: number, gitRef: string, inputs: Record<string, string>) =>
        backend.call<void>("dispatch", { ...repo, workflowId, gitRef, inputs }),
    rerun: (repo: RepoRef, runId: number, failedOnly: boolean, debug = false) => backend.call<void>("rerun", { ...repo, runId, failedOnly, debug }),
    rerunJob: (repo: RepoRef, jobId: number, debug = false) => backend.call<void>("rerunJob", { ...repo, jobId, debug }),
    cancel: (repo: RepoRef, runId: number) => backend.call<void>("cancel", { ...repo, runId }),
    deleteRunLogs: (repo: RepoRef, runId: number) => backend.call<void>("deleteRunLogs", { ...repo, runId }),
    deleteRun: (repo: RepoRef, runId: number) => backend.call<void>("deleteRun", { ...repo, runId }),
    downloadArtifact: (repo: RepoRef, artifactId: number, name: string, onProgress?: (progress: DownloadProgress) => void) =>
        download("downloadArtifact", { ...repo, artifactId, fileName: name }, onProgress),
    reviewDeployment: (repo: RepoRef, runId: number, environmentIds: number[], state: "approved" | "rejected", comment = "") =>
        backend.call<void>("reviewDeployment", { ...repo, runId, environmentIds, state, comment }),

    watchStart: (repo: RepoRef, runId: number, onTick: (tick: RunTick) => void) =>
        backend.openStream<RunTick>("watchRun", { ...repo, runId }, onTick),
    watchStop: (streamId: number) => backend.closeStream(streamId),
};

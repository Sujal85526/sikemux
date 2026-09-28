import { createPluginBackend, isPluginFailure } from "../../plugin-api/backend";
import { invalidate } from "../../plugin-api/resources";
import type {
    Annotation,
    Artifact,
    ChangedFile,
    Comment,
    DownloadProgress,
    Issue,
    IssuePage,
    JobLog,
    JobSummary,
    MergeMethod,
    NewPull,
    Notification,
    PendingApproval,
    Pull,
    PullCommit,
    Release,
    RepoListing,
    RepoRef,
    Resolved,
    Review,
    ReviewEvent,
    RunDetail,
    RunPage,
    RunQuery,
    RunTick,
    RunTiming,
    SavedArtifact,
    TimelineItem,
    Workflow,
    WorkflowFile,
    CodeHostApi,
    CommitAuthor,
    HostAccount,
} from "../../plugin-api/codehost";
import { GITHUB_PLUGIN_ID } from "./kinds";

export type * from "../../plugin-api/codehost";

const backend = createPluginBackend(GITHUB_PLUGIN_ID);

export type TokenSource = "keychain" | "environment" | "ghCli";

export interface ActionsStatus {
    configured: boolean;
    host: string;
    login: string;
    tokenSource: TokenSource | null;
    /** The variable an environment token was read from. */
    tokenVariable: string | null;
    scopes: string[];
    canWriteWorkflows: boolean;
    ok: boolean;
    authFailed: boolean;
    message: string | null;
}

export function failureMessage(error: unknown): string {
    return isPluginFailure(error) ? error.message : String(error);
}

function isSignedOut(error: unknown): boolean {
    if (!isPluginFailure(error)) return false;
    return error.category === "auth" || error.category === "unconfigured" || (error.category === "http" && error.status === 401);
}

/** A token GitHub has stopped accepting makes every cached answer stale, whichever call found out, so the next read lands on the sign-in form. */
function forgetSignedOut(): void {
    invalidate((kind) => kind.startsWith("host."));
}

async function call<T>(method: string, params?: unknown): Promise<T> {
    try {
        return await backend.call<T>(method, params);
    } catch (error) {
        if (isSignedOut(error)) forgetSignedOut();
        throw error;
    }
}

const IMAGES_KEPT = 400;
const images = new Map<string, Promise<string>>();

/**
 * An avatar or a picture from GitHub as a `data:` address, since the window cannot load GitHub's images itself. Each
 * address is fetched once; one that failed is tried again next time.
 */
function image(url: string): Promise<string> {
    const known = images.get(url);
    if (known) return known;
    const fetched = call<string>("image", { url });
    images.set(url, fetched);
    fetched.catch(() => images.delete(url));
    if (images.size > IMAGES_KEPT) {
        const oldest = images.keys().next().value;
        if (oldest !== undefined) images.delete(oldest);
    }
    return fetched;
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
            onError: (error) => {
                if (isSignedOut(error)) forgetSignedOut();
                reject(error);
            },
        });
    });
}

export const actionsApi = {
    status: () => backend.call<ActionsStatus>("status"),
    signIn: (host: string, token?: string) => backend.call<ActionsStatus>("signIn", { host, token }),
    signOut: () => backend.call<void>("signOut"),

    resolveRemote: (url: string) => backend.call<Resolved>("resolveRemote", { url }),
    myRepos: (limit = 50) => call<RepoListing[]>("myRepos", { limit }),

    workflows: (repo: RepoRef) => call<Workflow[]>("workflows", repo),
    branches: (repo: RepoRef) => call<string[]>("branches", repo),
    runs: (query: RunQuery) => call<RunPage>("runs", query),
    run: (repo: RepoRef, runId: number) => call<RunDetail>("run", { ...repo, runId }),
    jobLog: (repo: RepoRef, jobId: number) => call<JobLog>("jobLog", { ...repo, jobId }),
    annotations: (repo: RepoRef, checkRunId: number) => call<Annotation[]>("annotations", { ...repo, checkRunId }),
    jobSummary: (repo: RepoRef, checkRunId: number) => call<JobSummary | null>("jobSummary", { ...repo, checkRunId }),
    runTiming: (repo: RepoRef, runId: number) => call<RunTiming>("runTiming", { ...repo, runId }),
    workflowFile: (repo: RepoRef, workflowId: number) => call<WorkflowFile>("workflowFile", { ...repo, workflowId }),
    artifacts: (repo: RepoRef, runId: number) => call<Artifact[]>("artifacts", { ...repo, runId }),
    pendingApprovals: (repo: RepoRef, runId: number) => call<PendingApproval[]>("pendingApprovals", { ...repo, runId }),
    runAttempt: (repo: RepoRef, runId: number, attempt: number) => call<RunDetail>("runAttempt", { ...repo, runId, attempt }),

    pulls: (repo: RepoRef, state: string) => call<Pull[]>("pulls", { ...repo, state }),
    pull: (repo: RepoRef, number: number) => call<Pull>("pull", { ...repo, number }),
    pullFiles: (repo: RepoRef, number: number) => call<ChangedFile[]>("pullFiles", { ...repo, number }),
    pullCommits: (repo: RepoRef, number: number) => call<PullCommit[]>("pullCommits", { ...repo, number }),
    timeline: (repo: RepoRef, number: number) => call<TimelineItem[]>("timeline", { ...repo, number }),
    commitAuthors: (repo: RepoRef, gitRef: string | null) => call<CommitAuthor[]>("commitAuthors", { ...repo, gitRef }),
    pullReviews: (repo: RepoRef, number: number) => call<Review[]>("pullReviews", { ...repo, number }),
    issues: (repo: RepoRef, state: string, page: number) => call<IssuePage>("issues", { ...repo, state, page }),
    issue: (repo: RepoRef, number: number) => call<Issue>("issue", { ...repo, number }),
    comments: (repo: RepoRef, number: number) => call<Comment[]>("comments", { ...repo, number }),
    releases: (repo: RepoRef) => call<Release[]>("releases", repo),
    inbox: (all: boolean) => call<Notification[]>("inbox", { all }),
    image,

    /** `sha` is the head commit the person saw; GitHub refuses the merge if the branch has moved since. */
    mergePull: (repo: RepoRef, number: number, method: MergeMethod, sha: string) => call<void>("mergePull", { ...repo, number, method, sha }),
    createPull: (repo: RepoRef, pull: NewPull) => call<Pull>("createPull", { ...repo, ...pull }),
    setPullState: (repo: RepoRef, number: number, state: "open" | "closed") => call<void>("setPullState", { ...repo, number, state }),
    reviewPull: (repo: RepoRef, number: number, event: ReviewEvent, body: string) => call<void>("reviewPull", { ...repo, number, event, body }),
    createIssue: (repo: RepoRef, title: string, body: string) => call<Issue>("createIssue", { ...repo, title, body }),
    setIssueState: (repo: RepoRef, number: number, state: "open" | "closed") => call<void>("setIssueState", { ...repo, number, state }),
    addComment: (repo: RepoRef, number: number, body: string) => call<void>("addComment", { ...repo, number, body }),
    downloadAsset: (repo: RepoRef, assetId: number, name: string, onProgress?: (progress: DownloadProgress) => void) =>
        download("downloadAsset", { ...repo, assetId, fileName: name }, onProgress),
    markRead: (id: string) => call<void>("markRead", { id }),
    markAllRead: () => call<void>("markAllRead"),

    dispatch: (repo: RepoRef, workflowId: number, gitRef: string, inputs: Record<string, string>) =>
        call<void>("dispatch", { ...repo, workflowId, gitRef, inputs }),
    rerun: (repo: RepoRef, runId: number, failedOnly: boolean, debug = false) => call<void>("rerun", { ...repo, runId, failedOnly, debug }),
    rerunJob: (repo: RepoRef, jobId: number, debug = false) => call<void>("rerunJob", { ...repo, jobId, debug }),
    cancel: (repo: RepoRef, runId: number) => call<void>("cancel", { ...repo, runId }),
    deleteRunLogs: (repo: RepoRef, runId: number) => call<void>("deleteRunLogs", { ...repo, runId }),
    deleteRun: (repo: RepoRef, runId: number) => call<void>("deleteRun", { ...repo, runId }),
    downloadArtifact: (repo: RepoRef, artifactId: number, name: string, onProgress?: (progress: DownloadProgress) => void) =>
        download("downloadArtifact", { ...repo, artifactId, fileName: name }, onProgress),
    reviewDeployment: (repo: RepoRef, runId: number, environmentIds: number[], state: "approved" | "rejected", comment = "") =>
        call<void>("reviewDeployment", { ...repo, runId, environmentIds, state, comment }),

    watchStart: (repo: RepoRef, runId: number, onTick: (tick: RunTick) => void) =>
        backend
            .openStream<RunTick>("watchRun", { ...repo, runId }, (tick) => {
                if (tick.signedOut) forgetSignedOut();
                onTick(tick);
            })
            .catch((error: unknown) => {
                if (isSignedOut(error)) forgetSignedOut();
                throw error;
            }),
    watchStop: (streamId: number) => backend.closeStream(streamId),
};

/** GitHub serves every avatar from one place, and a company's own GitHub serves its users' from itself. */
function avatarOf(login: string, host: string): string {
    return host === "github.com" ? `https://avatars.githubusercontent.com/${login}?s=64` : `https://${host}/${login}.png?size=64`;
}

/** Where the signed-in account lives, so a name alone can find its picture. */
let accountHost = "github.com";

export function avatarForLogin(login: string): string | null {
    return login.endsWith("[bot]") || login.includes("/") ? null : avatarOf(login, accountHost);
}

function accountOf(status: ActionsStatus): HostAccount {
    if (status.host) accountHost = status.host;
    return {
        ok: status.ok,
        login: status.login,
        avatarUrl: status.login ? avatarOf(status.login, status.host) : null,
        host: status.host,
        canWriteCi: status.canWriteWorkflows,
        warning: status.ok && !status.canWriteWorkflows ? "This token cannot start or re-run workflows. It is missing the workflow scope." : null,
    };
}

/** GitHub as the git pane reads any code host. */
export const githubHostApi: CodeHostApi = {
    ...actionsApi,
    status: () => actionsApi.status().then(accountOf),
};

const NOREPLY = /^(\d+)\+[^@]+@users\.noreply\.github\.com$/iu;

/** GitHub's private commit emails carry the account's number, which is all its avatar address needs. */
export function avatarForEmail(email: string): string | null {
    const found = NOREPLY.exec(email.trim());
    return found ? `https://avatars.githubusercontent.com/u/${found[1]}?s=64` : null;
}

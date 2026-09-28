import { createContext, useContext, type ComponentType, type ReactNode } from "react";
import { isPluginEnabled } from "../plugins/enabled";
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
} from "./types";

/** Who is signed in to a host, in the terms every host shares. */
export interface HostAccount {
    /** Signed in and the token works. */
    ok: boolean;
    login: string;
    avatarUrl: string | null;
    /** The server, such as github.com or a company's own. */
    host: string;
    /** Whether this account may start, re-run and cancel CI. */
    canWriteCi: boolean;
    /** Something to tell the person about the sign-in, such as a missing permission. */
    warning: string | null;
}

/** What a host supports. The Git pane leaves out whatever a host cannot do rather than showing it empty. */
export interface HostCapabilities {
    ci: {
        graph: boolean;
        attempts: boolean;
        approvals: boolean;
        dispatch: boolean;
        annotations: boolean;
        summaries: boolean;
        artifacts: boolean;
        billing: boolean;
        workflowFile: boolean;
    };
    pulls: { draft: boolean; mergeMethods: readonly MergeMethod[]; requestChanges: boolean };
    issues: boolean;
    releases: boolean;
    inbox: boolean;
}

/** Every read and write a host answers. Each takes the repository it is about, whose `provider` names the host. */
export interface CodeHostApi {
    status(): Promise<HostAccount>;
    signOut(): Promise<void>;
    /** The repository a git remote points at, and in `sameHost` whether it is on the server this host talks to. */
    resolveRemote(url: string): Promise<Resolved>;
    myRepos(limit?: number): Promise<RepoListing[]>;
    image(url: string): Promise<string>;

    workflows(repo: RepoRef): Promise<Workflow[]>;
    branches(repo: RepoRef): Promise<string[]>;
    runs(query: RunQuery): Promise<RunPage>;
    run(repo: RepoRef, runId: number): Promise<RunDetail>;
    runAttempt(repo: RepoRef, runId: number, attempt: number): Promise<RunDetail>;
    jobLog(repo: RepoRef, jobId: number): Promise<JobLog>;
    annotations(repo: RepoRef, checkRunId: number): Promise<Annotation[]>;
    jobSummary(repo: RepoRef, checkRunId: number): Promise<JobSummary | null>;
    runTiming(repo: RepoRef, runId: number): Promise<RunTiming>;
    workflowFile(repo: RepoRef, workflowId: number): Promise<WorkflowFile>;
    artifacts(repo: RepoRef, runId: number): Promise<Artifact[]>;
    pendingApprovals(repo: RepoRef, runId: number): Promise<PendingApproval[]>;
    dispatch(repo: RepoRef, workflowId: number, gitRef: string, inputs: Record<string, string>): Promise<void>;
    rerun(repo: RepoRef, runId: number, failedOnly: boolean, debug?: boolean): Promise<void>;
    rerunJob(repo: RepoRef, jobId: number, debug?: boolean): Promise<void>;
    cancel(repo: RepoRef, runId: number): Promise<void>;
    deleteRunLogs(repo: RepoRef, runId: number): Promise<void>;
    deleteRun(repo: RepoRef, runId: number): Promise<void>;
    reviewDeployment(repo: RepoRef, runId: number, environmentIds: number[], state: "approved" | "rejected", comment?: string): Promise<void>;
    downloadArtifact(repo: RepoRef, artifactId: number, name: string, onProgress?: (progress: DownloadProgress) => void): Promise<SavedArtifact>;
    watchStart(repo: RepoRef, runId: number, onTick: (tick: RunTick) => void): Promise<number>;
    watchStop(streamId: number): Promise<void>;

    pulls(repo: RepoRef, state: string): Promise<Pull[]>;
    pull(repo: RepoRef, number: number): Promise<Pull>;
    pullFiles(repo: RepoRef, number: number): Promise<ChangedFile[]>;
    pullCommits(repo: RepoRef, number: number): Promise<PullCommit[]>;
    pullReviews(repo: RepoRef, number: number): Promise<Review[]>;
    timeline(repo: RepoRef, number: number): Promise<TimelineItem[]>;
    /** `sha` is the head commit the person saw; the host refuses the merge if the branch has moved since. */
    mergePull(repo: RepoRef, number: number, method: MergeMethod, sha: string): Promise<void>;
    createPull(repo: RepoRef, pull: NewPull): Promise<Pull>;
    setPullState(repo: RepoRef, number: number, state: "open" | "closed"): Promise<void>;
    reviewPull(repo: RepoRef, number: number, event: ReviewEvent, body: string): Promise<void>;

    issues(repo: RepoRef, state: string, page: number): Promise<IssuePage>;
    issue(repo: RepoRef, number: number): Promise<Issue>;
    createIssue(repo: RepoRef, title: string, body: string): Promise<Issue>;
    setIssueState(repo: RepoRef, number: number, state: "open" | "closed"): Promise<void>;
    comments(repo: RepoRef, number: number): Promise<Comment[]>;
    addComment(repo: RepoRef, number: number, body: string): Promise<void>;

    releases(repo: RepoRef): Promise<Release[]>;
    downloadAsset(repo: RepoRef, assetId: number, name: string, onProgress?: (progress: DownloadProgress) => void): Promise<SavedArtifact>;

    inbox(all: boolean): Promise<Notification[]>;
    markRead(id: string): Promise<void>;
    markAllRead(): Promise<void>;
}

export interface CodeHost {
    /** The plugin's id, which is also what `RepoRef.provider` holds. */
    readonly id: string;
    readonly name: string;
    /** What the host calls its CI, such as Actions or Pipelines. */
    readonly ciName: string;
    readonly icon: (size: number) => ReactNode;
    readonly capabilities: HostCapabilities;
    readonly api: CodeHostApi;
    /** The ref a pull request from a fork can be fetched by, such as GitHub's `pull/N/head`. */
    readonly pullHeadRef?: (number: number) => string;
    /** Shown in the Git pane while nobody is signed in to this host. */
    readonly SignIn: ComponentType<{ onSignedIn: () => void }>;
}

const hosts = new Map<string, CodeHost>();

export function registerCodeHost(host: CodeHost): void {
    if (hosts.has(host.id)) throw new Error(`code host ${host.id} is registered twice`);
    hosts.set(host.id, host);
}

export function codeHost(id: string): CodeHost | undefined {
    return hosts.get(id);
}

export function codeHosts(): readonly CodeHost[] {
    return [...hosts.values()];
}

/** Hosts whose plugin the person has not switched off, in the order they registered. */
export function enabledCodeHosts(): readonly CodeHost[] {
    return codeHosts().filter((host) => isPluginEnabled(host.id));
}

export function hostApi(id: string): CodeHostApi {
    const host = hosts.get(id);
    if (!host) throw new Error(`no code host ${id} is registered`);
    return host.api;
}

const HostContext = createContext<CodeHost | null>(null);

export const HostProvider = HostContext.Provider;

/** The host the Git pane is showing, for the few reads that are about an account rather than a repository. */
export function useHost(): CodeHost {
    const host = useContext(HostContext);
    if (!host) throw new Error("useHost is only for what the Git pane draws inside a host");
    return host;
}

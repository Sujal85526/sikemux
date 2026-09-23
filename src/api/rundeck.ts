import { pluginsApi, type PluginStreamEvent } from "./plugins";
import { emit } from "../state/bus";

const RUNDECK = "sikemux.rundeck";

const call = <T>(method: string, params: unknown = null) => pluginsApi.call<T>(RUNDECK, method, params);

function stream<T>(method: string, params: unknown, onItem: (item: T) => void): Promise<number> {
    return pluginsApi.streamStart(RUNDECK, method, params, (event: PluginStreamEvent) => {
        if (event.kind === "item") onItem(event.value as T);
    });
}

async function rndInvoke<T>(method: string, params?: unknown): Promise<T> {
    try {
        return await call<T>(method, params);
    } catch (e) {
        const err = e as { category?: string; status?: number; message?: string };
        const cat = err?.category ?? "";
        const isAuth = cat === "auth" || cat === "unconfigured" || (cat === "http" && (err?.status === 401 || err?.status === 403));
        if (isAuth) {
            emit({
                type: "rnd-auth-expired",
                reason: err?.message ?? cat ?? "auth",
            });
        }
        throw e;
    }
}

export interface RundeckStatus {
    configured: boolean;
    url: string;
    user: string;
    token_present: boolean;
    rundeck_version: string | null;
    ok: boolean;
    auth_failed: boolean;
    message: string | null;
    allow_insecure_private_http: boolean;
}

export interface RundeckLoginRequest {
    url: string;
    user: string;
    password: string;
    allow_insecure_private_http: boolean;
}

export interface RundeckLoginResult {
    url: string;
    user: string;
    token_set: boolean;
    rundeck_version: string | null;
}

export interface RundeckProject {
    name: string;
    description: string | null;
}

export interface RundeckJob {
    id: string;
    name: string;
    group: string | null;
    project: string;
    description: string | null;
    href: string | null;
    permalink: string | null;
}

export interface RundeckEnvSpec {
    label: string;
    project: string;
    only_succeeded?: boolean;
}

export interface MatrixCell {
    service: string;
    name: string;
    job_id: string;
    group: string | null;
    branch: string | null;
    status: string | null;
    user: string | null;
    started_at: string | null;
    ended_at: string | null;
    execution_id: number | null;
    permalink: string | null;
    error: string | null;
}

export interface MatrixEnv {
    env: string;
    project: string;
    cells: MatrixCell[];
    error: string | null;
}

export interface MatrixResult {
    envs: MatrixEnv[];
    elapsed_ms: number;
}

export interface RundeckExecution {
    id: number;
    status: string | null;
    user: string | null;
    project: string | null;
    ["date-started"]: { date: string | null; unixtime: number | null } | null;
    ["date-ended"]: { date: string | null; unixtime: number | null } | null;
    permalink: string | null;
    job: {
        id: string | null;
        name: string | null;
        group: string | null;
        project: string | null;
        options: Record<string, string> | null;
    } | null;
    argstring: string | null;
    workflowState?: RundeckWorkflowState | null;
}

export interface RunResult {
    id: number;
    permalink: string | null;
    status: string | null;
}

export interface AbortResult {
    abort: { status: string | null; reason: string | null } | null;
    execution: RundeckExecution | null;
}

export interface RundeckStep {
    id: string | null;
    stepctx: string | null;
    executionState: string | null;
    startTime: string | null;
    endTime: string | null;
    nodeStep: boolean | null;
}

export interface RundeckWorkflowState {
    executionState: string | null;
    steps: RundeckStep[];
    stepCount: number | null;
    completed: boolean | null;
}

export interface WatchUpdate {
    execution: RundeckExecution | null;
    state: RundeckWorkflowState | null;
    error: string | null;
    terminal: boolean;
}

export interface LogEntry {
    time: string | null;
    level: string | null;
    log: string | null;
    user: string | null;
    stepctx: string | null;
    node: string | null;
}

export interface LogTick {
    entries: LogEntry[];
    completed: boolean;
    error: string | null;
}

export type BranchRelation =
    | "same"
    | "target-contains-deployed"
    | "target-missing-deployed"
    | "unknown-no-deployed-branch"
    | "unknown-deployed-not-on-origin"
    | "unknown-target-not-on-origin";

export type PushAction = "will-push-current" | "will-not-push-different-branch" | "will-not-push-no-repo" | "will-not-push-detached";

export interface PlanResult {
    project: string;
    service: string;
    target_branch: string;
    deployed_branch: string | null;
    branch_relation: BranchRelation;
    branch_relation_detail: string | null;
    git_root: string | null;
    current_branch: string | null;
    head_sha: string | null;
    dirty: boolean;
    upstream: string | null;
    ahead: number | null;
    behind: number | null;
    remote_target_exists: boolean;
    push_action: PushAction;
}

export const rundeckApi = {
    status: () => call<RundeckStatus>("status"),
    login: (req: RundeckLoginRequest) => rndInvoke<RundeckLoginResult>("login", req),
    logout: () => call<void>("logout"),

    projects: () => rndInvoke<RundeckProject[]>("projects"),
    jobs: (project: string) => rndInvoke<RundeckJob[]>("jobs", { project }),
    branchesMatrix: (envs: RundeckEnvSpec[]) => rndInvoke<MatrixResult>("branchesMatrix", { envs }),
    resolveJob: (project: string, service: string) => rndInvoke<RundeckJob>("resolveJob", { project, service }),

    executions: (jobId: string, project: string, max = 25, onlySucceeded = false) =>
        rndInvoke<RundeckExecution[]>("executions", {
            jobId,
            project,
            max,
            onlySucceeded,
        }),
    execution: (executionId: number) => rndInvoke<RundeckExecution>("execution", { executionId }),
    executionState: (executionId: number) => rndInvoke<RundeckWorkflowState>("executionState", { executionId }),
    run: (project: string, service: string, branch: string, extraOptions?: Record<string, string>) =>
        rndInvoke<RunResult>("run", {
            project,
            service,
            branch,
            extraOptions: extraOptions ?? null,
        }),
    abort: (executionId: number) => rndInvoke<AbortResult>("abort", { executionId }),

    watchStart: (executionId: number, onUpdate: (u: WatchUpdate) => void) => stream("watch", { executionId }, onUpdate),
    watchStop: (id: number) => pluginsApi.streamStop(id),

    logsStart: (executionId: number, backlog: number | null, onChunk: (c: LogTick) => void) => stream("logs", { executionId, backlog }, onChunk),
    logsStop: (id: number) => pluginsApi.streamStop(id),

    plan: (project: string, service: string, targetBranch: string, repoPath: string) =>
        rndInvoke<PlanResult>("plan", {
            project,
            service,
            targetBranch,
            repoPath,
        }),
};

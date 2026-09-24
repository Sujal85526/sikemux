import { resource } from "../../plugin-api/resources";
import {
    rundeckApi,
    type MatrixResult,
    type PlanResult,
    type RundeckEnvSpec,
    type RundeckExecution,
    type RundeckJob,
    type RundeckProject,
    type RundeckStatus,
} from "./api";

export const rndStatusR = resource({
    kind: "rnd.status",
    fetch: (): Promise<RundeckStatus> => rundeckApi.status(),
    staleAfterMs: 60_000,
});

export const rndProjectsR = resource({
    kind: "rnd.projects",
    fetch: (): Promise<RundeckProject[]> => rundeckApi.projects(),
    staleAfterMs: 5 * 60_000,
});

export const rndJobsR = resource({
    kind: "rnd.jobs",
    fetch: (project: string): Promise<RundeckJob[]> => rundeckApi.jobs(project),
    staleAfterMs: 60_000,
});

export const rndMatrixR = resource({
    kind: "rnd.matrix",
    fetch: (envs: RundeckEnvSpec[]): Promise<MatrixResult> => rundeckApi.branchesMatrix(envs),
    staleAfterMs: 30_000,
});

export const rndExecutionsR = resource({
    kind: "rnd.executions",
    fetch: (jobId: string, project: string, max: number): Promise<RundeckExecution[]> => rundeckApi.executions(jobId, project, max),
    staleAfterMs: 15_000,
});

export const rndPlanR = resource({
    kind: "rnd.plan",
    fetch: (project: string, service: string, branch: string, repoPath: string): Promise<PlanResult> =>
        rundeckApi.plan(project, service, branch, repoPath),
    staleAfterMs: 10_000,
});

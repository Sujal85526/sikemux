import { create } from "zustand";
import { closeCorePalettes, onPaneClosed, openSurface } from "../../plugin-api/host";
import { definePluginSettings } from "../../plugin-api/settings";
import { RUNDECK_DEPLOY, RUNDECK_PLUGIN_ID } from "./kinds";
import { envFolderOf, inferEnv } from "./shape";

export type RundeckLevel =
    | { kind: "matrix" }
    | { kind: "service"; env: string; project: string; service: string; jobId: string; repoPath?: string }
    | {
          kind: "deploy";
          env: string;
          project: string;
          service: string;
          jobId: string;
          branch: string;
          repoPath?: string;
      }
    | { kind: "execution"; executionId: number; service: string; project: string; env?: string; jobId?: string; repoPath?: string };

export interface RundeckView {
    stack: RundeckLevel[];
}

/** A place a service is deployed from: a Rundeck project plus an env subfolder. */
export interface DeployRef {
    project: string;
    folder: string | null;
}

export interface RundeckSettings {
    activeProject: string;
    activeEnvFolder: string | null;
    prodEnvs: string[];
    /** The deploy location picked for each project folder. */
    deployTargets: Record<string, DeployRef>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

function decodeDeployRef(value: unknown): DeployRef | null {
    if (!isRecord(value) || typeof value.project !== "string") return null;
    if (value.folder !== null && typeof value.folder !== "string") return null;
    return { project: value.project, folder: value.folder };
}

function decodeSettings(saved: unknown): RundeckSettings {
    const raw = isRecord(saved) ? saved : {};
    const deployTargets: Record<string, DeployRef> = {};
    for (const [cwd, target] of Object.entries(isRecord(raw.deployTargets) ? raw.deployTargets : {})) {
        const ref = decodeDeployRef(target);
        if (ref) deployTargets[cwd] = ref;
    }
    return {
        activeProject: typeof raw.activeProject === "string" ? raw.activeProject : "",
        activeEnvFolder: typeof raw.activeEnvFolder === "string" ? raw.activeEnvFolder : null,
        prodEnvs: Array.isArray(raw.prodEnvs) ? raw.prodEnvs.filter((env): env is string => typeof env === "string") : ["prod", "production"],
        deployTargets,
    };
}

export const rundeckSettings = definePluginSettings(RUNDECK_PLUGIN_ID, decodeSettings);

export function setDeployTarget(projectCwd: string, target: DeployRef): void {
    rundeckSettings.update((settings) => ({ ...settings, deployTargets: { ...settings.deployTargets, [projectCwd]: target } }));
}

interface RundeckRuntime {
    views: Record<string, RundeckView>;
    jobPaletteOpen: boolean;
}

export const useRundeck = create<RundeckRuntime>()(() => ({ views: {}, jobPaletteOpen: false }));

onPaneClosed((paneId) => {
    if (!(paneId in useRundeck.getState().views)) return;
    useRundeck.setState((state) => {
        const views = { ...state.views };
        delete views[paneId];
        return { views };
    });
});

const HOME: RundeckView = { stack: [{ kind: "matrix" }] };

export const rundeckView = (paneId: string): RundeckView => useRundeck.getState().views[paneId] ?? HOME;

export function useRundeckView(paneId: string): RundeckView {
    return useRundeck((state) => state.views[paneId] ?? HOME);
}

function setStack(paneId: string, stack: RundeckLevel[]): void {
    useRundeck.setState((state) => ({ views: { ...state.views, [paneId]: { stack } } }));
}

export function rundeckPush(paneId: string, level: RundeckLevel): void {
    setStack(paneId, [...rundeckView(paneId).stack, level]);
}

export function rundeckReplace(paneId: string, level: RundeckLevel): void {
    setStack(paneId, [...rundeckView(paneId).stack.slice(0, -1), level]);
}

export function rundeckPop(paneId: string): void {
    const { stack } = rundeckView(paneId);
    if (stack.length > 1) setStack(paneId, stack.slice(0, -1));
}

export function rundeckPopTo(paneId: string, index: number): void {
    const { stack } = rundeckView(paneId);
    const target = Math.max(0, Math.min(index, stack.length - 1));
    setStack(paneId, stack.slice(0, target + 1));
}

export function rundeckHome(paneId: string): void {
    setStack(paneId, HOME.stack);
}

function setRundeckProject(project: string, envFolder: string | null = null): void {
    rundeckSettings.update((settings) => ({ ...settings, activeProject: project, activeEnvFolder: envFolder }));
}

export function selectRundeckProject(paneId: string, project: string, envFolder: string | null = null): void {
    setRundeckProject(project, envFolder);
    rundeckHome(paneId);
}

export function openRundeckJobPalette(): void {
    closeCorePalettes();
    useRundeck.setState({ jobPaletteOpen: true });
}

export function closeRundeckJobPalette(): void {
    useRundeck.setState({ jobPaletteOpen: false });
}

export function toggleRundeckJobPalette(): void {
    if (useRundeck.getState().jobPaletteOpen) closeRundeckJobPalette();
    else openRundeckJobPalette();
}

export const openRundeckSession = (): void => {
    openSurface(RUNDECK_DEPLOY);
};

interface RundeckTarget {
    project: string;
    service: string;
    jobId: string;
    group: string | null;
}

/** Open the Rundeck session straight to a known service, and to its deploy form when a branch is given. */
export function openRundeckTarget(target: RundeckTarget, repoPath: string, branch?: string): void {
    const env = inferEnv(target.project, target.group);
    const paneId = openSurface(RUNDECK_DEPLOY);
    if (!paneId) return;
    setRundeckProject(target.project, envFolderOf(target.group));
    const common = { env, project: target.project, service: target.service, jobId: target.jobId, repoPath };
    setStack(paneId, [
        { kind: "matrix" },
        { kind: "service", ...common },
        ...(branch !== undefined ? [{ kind: "deploy" as const, ...common, branch }] : []),
    ]);
}

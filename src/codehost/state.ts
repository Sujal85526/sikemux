import { create } from "zustand";
import { onPaneClosed } from "../plugin-api/host";
import { definePluginSettings, type PluginSettings } from "../plugin-api/settings";
import { setGitView } from "../state/commands";
import type { RepoRef } from "./types";

export const STATUS_FILTERS = ["all", "in_progress", "queued", "success", "failure", "cancelled"] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];

export const SECTIONS = ["pulls", "actions", "issues", "releases", "inbox"] as const;
export type Section = (typeof SECTIONS)[number];

export function isSection(value: unknown): value is Section {
    return typeof value === "string" && (SECTIONS as readonly string[]).includes(value);
}

export function needsRepo(section: Section): boolean {
    return section !== "inbox";
}

export interface HostSettings {
    pinned: string[];
    /** A repository picked by hand for a project folder, which wins over what its remote says. */
    repoByProject: Record<string, string>;
    followBranch: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const isSlug = (value: unknown): value is string => typeof value === "string" && /^[\w.-]+\/[\w.-]+$/u.test(value);

function decodeSettings(saved: unknown): HostSettings {
    const raw = isRecord(saved) ? saved : {};
    const repoByProject: Record<string, string> = {};
    for (const [cwd, slug] of Object.entries(isRecord(raw.repoByProject) ? raw.repoByProject : {})) {
        if (isSlug(slug)) repoByProject[cwd] = slug;
    }
    return {
        pinned: Array.isArray(raw.pinned) ? [...new Set(raw.pinned.filter(isSlug))] : [],
        repoByProject,
        followBranch: raw.followBranch !== false,
    };
}

const settingsByHost = new Map<string, PluginSettings<HostSettings>>();

/** Kept with the host plugin's own settings, so what someone pinned stays with the host it was pinned on. */
export function hostSettings(provider: string): PluginSettings<HostSettings> {
    let settings = settingsByHost.get(provider);
    if (!settings) {
        settings = definePluginSettings(provider, decodeSettings);
        settingsByHost.set(provider, settings);
    }
    return settings;
}

export function togglePinned(provider: string, slug: string): void {
    hostSettings(provider).update((settings) => ({
        ...settings,
        pinned: settings.pinned.includes(slug) ? settings.pinned.filter((kept) => kept !== slug) : [...settings.pinned, slug],
    }));
}

export function setProjectRepo(provider: string, cwd: string, slug: string | null): void {
    hostSettings(provider).update((settings) => {
        const repoByProject = { ...settings.repoByProject };
        if (slug) repoByProject[cwd] = slug;
        else delete repoByProject[cwd];
        return { ...settings, repoByProject };
    });
}

export function setFollowBranch(provider: string, followBranch: boolean): void {
    hostSettings(provider).update((settings) => ({ ...settings, followBranch }));
}

/** What one Git pane shows of its host: the open section is kept in the pane's own view, everything else here. */
export interface HostView {
    /** The pull request or issue open in this pane, by number. */
    item: number | null;
    /** `open`, `closed` or `all`, for whichever list is showing. */
    listState: string;
    workflowId: number | null;
    statusFilter: StatusFilter;
    /** A branch typed into the filter, which wins over following the project's branch. */
    branch: string | null;
    run: number | null;
    job: number | null;
    page: number;
    dispatching: number | null;
    composing: "pull" | "issue" | null;
}

const FRESH: HostView = {
    item: null,
    listState: "open",
    workflowId: null,
    statusFilter: "all",
    branch: null,
    run: null,
    job: null,
    page: 1,
    dispatching: null,
    composing: null,
};

export const useHostViews = create<{ views: Record<string, HostView>; paletteOpen: boolean }>()(() => ({
    views: {},
    paletteOpen: false,
}));

export function togglePalette(): void {
    useHostViews.setState((state) => ({ paletteOpen: !state.paletteOpen }));
}

export function closePalette(): void {
    useHostViews.setState({ paletteOpen: false });
}

onPaneClosed((paneId) => {
    if (!(paneId in useHostViews.getState().views)) return;
    useHostViews.setState((state) => {
        const views = { ...state.views };
        delete views[paneId];
        return { views };
    });
});

export function useHostView(paneId: string): HostView {
    return useHostViews((state) => state.views[paneId] ?? FRESH);
}

export function viewOf(paneId: string): HostView {
    return useHostViews.getState().views[paneId] ?? FRESH;
}

export function updateView(paneId: string, patch: Partial<HostView>): void {
    useHostViews.setState((state) => ({ views: { ...state.views, [paneId]: { ...(state.views[paneId] ?? FRESH), ...patch } } }));
}

/** Everything a pane had open belongs to the repository it was showing, so a different one starts clean. */
export function resetView(paneId: string): void {
    updateView(paneId, FRESH);
}

export function filterBy(paneId: string, patch: Pick<Partial<HostView>, "workflowId" | "statusFilter" | "branch">): void {
    updateView(paneId, { ...patch, item: null, composing: null, page: 1, run: null, job: null });
}

/** Leaving a section closes whatever was open in the one before. */
export function leaveSection(paneId: string): void {
    updateView(paneId, { item: null, run: null, job: null, page: 1, composing: null });
}

export function showItem(paneId: string, number: number | null): void {
    updateView(paneId, { item: number, composing: null });
}

export function compose(paneId: string, composing: "pull" | "issue" | null): void {
    updateView(paneId, { composing, item: null });
}

export function setListState(paneId: string, listState: string): void {
    updateView(paneId, { listState, item: null, page: 1 });
}

/** A check on a pull request opens its run, in the same pane. */
export function openRunFrom(paneId: string, runId: number): void {
    setGitView(paneId, { area: "actions" });
    updateView(paneId, { item: null, composing: null, run: runId, job: null });
}

export function showRun(paneId: string, runId: number): void {
    updateView(paneId, { run: runId, job: null });
}

export function closeRun(paneId: string): void {
    updateView(paneId, { run: null, job: null });
}

export function refOf(provider: string, slug: string): RepoRef | null {
    const [owner, name, ...rest] = slug.split("/");
    if (!owner || !name || rest.length > 0) return null;
    return { provider, owner, name };
}

export function slugOf(repo: Pick<RepoRef, "owner" | "name">): string {
    return `${repo.owner}/${repo.name}`;
}

export function sameRepo(a: RepoRef | null, b: RepoRef | null): boolean {
    return !!a && !!b && a.provider === b.provider && slugOf(a) === slugOf(b);
}

import { create } from "zustand";
import { onPaneClosed, openSurface } from "../../plugin-api/host";
import { definePluginSettings } from "../../plugin-api/settings";
import type { RepoRef } from "./api";
import { GITHUB_PLUGIN_ID, GITHUB_HUB } from "./kinds";

export const STATUS_FILTERS = ["all", "in_progress", "queued", "success", "failure", "cancelled"] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];

/** The parts of GitHub the pane can show, in the order the sidebar lists them. */
export const SECTIONS = ["actions", "pulls", "issues", "releases", "inbox"] as const;
export type Section = (typeof SECTIONS)[number];

export const SECTION_LABEL: Record<Section, string> = {
    actions: "Actions",
    pulls: "Pull requests",
    issues: "Issues",
    releases: "Releases",
    inbox: "Inbox",
};

/** Whether a section is about one repository, or about the whole account. */
export function needsRepo(section: Section): boolean {
    return section !== "inbox";
}

export interface ActionsSettings {
    /** Repositories kept in the sidebar, as `owner/repo`. */
    pinned: string[];
    /** The repository each project folder shows, when its git remote is not the one to use. */
    repoByProject: Record<string, string>;
    /** The repository to open when no project is in front. */
    lastRepo: string | null;
    /** Only show runs on the branch the project is checked out at. */
    followBranch: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const isSlug = (value: unknown): value is string => typeof value === "string" && /^[\w.-]+\/[\w.-]+$/u.test(value);

function decodeSettings(saved: unknown): ActionsSettings {
    const raw = isRecord(saved) ? saved : {};
    const repoByProject: Record<string, string> = {};
    for (const [cwd, slug] of Object.entries(isRecord(raw.repoByProject) ? raw.repoByProject : {})) {
        if (isSlug(slug)) repoByProject[cwd] = slug;
    }
    return {
        pinned: Array.isArray(raw.pinned) ? [...new Set(raw.pinned.filter(isSlug))] : [],
        repoByProject,
        lastRepo: isSlug(raw.lastRepo) ? raw.lastRepo : null,
        followBranch: raw.followBranch !== false,
    };
}

export const actionsSettings = definePluginSettings(GITHUB_PLUGIN_ID, decodeSettings);

export function togglePinned(slug: string): void {
    actionsSettings.update((settings) => ({
        ...settings,
        pinned: settings.pinned.includes(slug) ? settings.pinned.filter((kept) => kept !== slug) : [...settings.pinned, slug],
    }));
}

export function rememberRepo(slug: string): void {
    actionsSettings.update((settings) => ({ ...settings, lastRepo: slug }));
}

export function setProjectRepo(cwd: string, slug: string | null): void {
    actionsSettings.update((settings) => {
        const repoByProject = { ...settings.repoByProject };
        if (slug) repoByProject[cwd] = slug;
        else delete repoByProject[cwd];
        return { ...settings, repoByProject };
    });
}

export function setFollowBranch(followBranch: boolean): void {
    actionsSettings.update((settings) => ({ ...settings, followBranch }));
}

export interface RunsView {
    section: Section;
    /** The pull request or issue open in this pane, by number. */
    item: number | null;
    /** `open`, `closed` or `all`, for whichever list is showing. */
    listState: string;
    /** The repository this pane is showing, or null while one is still being worked out. */
    repo: RepoRef | null;
    workflowId: number | null;
    statusFilter: StatusFilter;
    /** A branch typed into the filter, which wins over following the project's branch. */
    branch: string | null;
    run: number | null;
    job: number | null;
    page: number;
    dispatching: number | null;
    /** A new pull request or issue being written in this pane. */
    composing: "pull" | "issue" | null;
}

const FRESH: RunsView = {
    section: "actions",
    item: null,
    listState: "open",
    repo: null,
    workflowId: null,
    statusFilter: "all",
    branch: null,
    run: null,
    job: null,
    page: 1,
    dispatching: null,
    composing: null,
};

export const useActions = create<{ views: Record<string, RunsView>; paletteOpen: boolean }>()(() => ({
    views: {},
    paletteOpen: false,
}));

export function togglePalette(): void {
    useActions.setState((state) => ({ paletteOpen: !state.paletteOpen }));
}

export function closePalette(): void {
    useActions.setState({ paletteOpen: false });
}

onPaneClosed((paneId) => {
    if (!(paneId in useActions.getState().views)) return;
    useActions.setState((state) => {
        const views = { ...state.views };
        delete views[paneId];
        return { views };
    });
});

export function useRunsView(paneId: string): RunsView {
    return useActions((state) => state.views[paneId] ?? FRESH);
}

export function viewOf(paneId: string): RunsView {
    return useActions.getState().views[paneId] ?? FRESH;
}

export function updateView(paneId: string, patch: Partial<RunsView>): void {
    useActions.setState((state) => ({ views: { ...state.views, [paneId]: { ...(state.views[paneId] ?? FRESH), ...patch } } }));
}

/** Changing what the list is of always starts it again from the first page. */
export function filterBy(paneId: string, patch: Pick<Partial<RunsView>, "workflowId" | "statusFilter" | "branch">): void {
    updateView(paneId, { ...patch, page: 1, run: null, job: null });
}

export function showRepo(paneId: string, repo: RepoRef): void {
    updateView(paneId, { ...FRESH, repo });
    rememberRepo(`${repo.owner}/${repo.name}`);
}

export function showSection(paneId: string, section: Section): void {
    updateView(paneId, { section, item: null, run: null, job: null, page: 1, composing: null });
}

export function showItem(paneId: string, number: number | null): void {
    updateView(paneId, { item: number, composing: null });
}

export function compose(paneId: string, composing: "pull" | "issue" | null): void {
    updateView(paneId, { composing, item: null });
}

/** A run named somewhere else in the pane, such as a pull request's checks, opened in Actions. */
export function openRunFrom(paneId: string, runId: number): void {
    updateView(paneId, { section: "actions", item: null, composing: null, run: runId, job: null });
}

export function setListState(paneId: string, listState: string): void {
    updateView(paneId, { listState, item: null });
}

export function showRun(paneId: string, runId: number): void {
    updateView(paneId, { run: runId, job: null });
}

export function closeRun(paneId: string): void {
    updateView(paneId, { run: null, job: null });
}

/** `owner/repo` split back into the pair every call wants. */
export function refOf(slug: string): RepoRef | null {
    const [owner, name, ...rest] = slug.split("/");
    if (!owner || !name || rest.length > 0) return null;
    return { owner, name };
}

export function slugOf(repo: RepoRef): string {
    return `${repo.owner}/${repo.name}`;
}

export function openActions(): void {
    openSurface(GITHUB_HUB);
}

/** Brings the runs view forward on one repository, from anywhere that names it. */
export function openRepo(repo: RepoRef): void {
    const paneId = openSurface(GITHUB_HUB);
    if (paneId) showRepo(paneId, repo);
}

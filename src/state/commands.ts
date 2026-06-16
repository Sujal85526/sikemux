import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { AgentSession } from "../api/agents";
import { awsApi } from "../api/aws";
import { fsapi } from "../api/fs";
import { lsp } from "../api/lsp";
import { emptyRequest } from "../bruno/types";
import { parseRequest } from "../bruno/parse";
import { serializeRequest } from "../bruno/serialize";
import { basename, dirname } from "../lib/paths";
import { applyTheme, applyWindowOpacity } from "../themes/bus";
import { emit } from "./bus";
import { fetchResource, invalidate, peekResource } from "./resources";
import { agentSessionsR, awsIdentityR, projectRootsScanR } from "./resources.defs";
import { envFolderOf, inferEnv } from "./rundeckShape";
import { getState, mutate, setState, type StoreState } from "./store";
import { notify, reportError, swallow } from "./toast";
import { DEFAULT_BRUNO_VIEW, DEFAULT_GIT_VIEW, DEFAULT_GLOBAL_SEARCH_VIEW } from "./types";
import {
    collectPanes,
    computeLayout,
    makePane,
    neighborPane,
    newId,
    removePane,
    resizeTowards,
    setSplitSizes as setSplitSizesFn,
    splitPane,
} from "./layout";
import type {
    Agent,
    AgentBookmark,
    AgentType,
    AwsService,
    BrunoReqTab,
    BrunoResTab,
    BrunoView,
    DeployRef,
    EcsLevel,
    FocusDir,
    PickerMode,
    PaneKind,
    PinnedProject,
    ProjectRoot,
    RundeckLevel,
    RundeckView,
    Session,
    SessionKind,
    SplitDir,
    Window,
    WindowRole,
} from "./types";

const patchSession = (id: string, fn: (s: Session) => Session): void =>
    mutate((d) => {
        const cur = d.sessions[id];
        if (!cur) return;
        d.sessions[id] = fn(cur as Session);
    });

const patchWindow = (id: string, fn: (w: Window) => Window): void =>
    mutate((d) => {
        const cur = d.windows[id];
        if (!cur) return;
        d.windows[id] = fn(cur as Window);
    });

const withActiveSession = (fn: (d: StoreState, session: Session) => void): void =>
    mutate((d) => {
        const session = d.sessions[d.activeSessionId];
        if (!session) return;
        fn(d as unknown as StoreState, session as Session);
    });

const withActiveWindow = (fn: (d: StoreState, win: Window, session: Session) => void): void =>
    mutate((d) => {
        const session = d.sessions[d.activeSessionId];
        if (!session) return;
        const win = d.windows[session.activeWindowId];
        if (!win) return;
        fn(d as unknown as StoreState, win as Window, session as Session);
    });

function makeWindow(
    cwd: string,
    name: string,
    opts: {
        kind?: PaneKind;
        startup?: string;
        fixed?: boolean;
        role?: WindowRole;
    } = {},
): Window {
    const pane = makePane(cwd, opts);
    const win: Window = {
        id: newId("win"),
        name,
        role: opts.role ?? "term",
        root: pane,
        activePaneId: pane.id,
    };
    if (opts.fixed) win.fixed = true;
    return win;
}

function makeSession(kind: SessionKind, name: string, cwd: string, activeWindowId: string): Session {
    return {
        id: newId("sess"),
        name,
        kind,
        cwd,
        deploy: null,
        pinned: false,
        activeWindowId,
        activeAgentId: null,
        view: "windows",
    };
}

function projectWindows(cwd: string): Window[] {
    return [
        makeWindow(cwd, "files", { kind: "editor", fixed: true, role: "files" }),
        makeWindow(cwd, "term", { fixed: true, role: "term" }),
        makeWindow(cwd, "git", { kind: "git", fixed: true, role: "git" }),
        makeWindow(cwd, "search", { kind: "search", fixed: true, role: "search" }),
    ];
}

export function ensureSearchWindow(): void {
    mutate((d) => {
        for (const sid of d.sessionOrder) {
            const sess = d.sessions[sid];
            if (sess.kind !== "project") continue;
            const winIds = d.windowsBySession[sid] ?? [];
            if (winIds.some((id) => d.windows[id]?.role === "search")) continue;
            const w = makeWindow(sess.cwd, "search", {
                kind: "search",
                fixed: true,
                role: "search",
            });
            d.windows[w.id] = w;
            d.windowsBySession[sid] = [...winIds, w.id];
        }
    });
}

function attachSession(d: StoreState, session: Session, windows: Window[], agents: Agent[] = []): void {
    d.sessions[session.id] = session;
    d.sessionOrder.push(session.id);
    for (const w of windows) d.windows[w.id] = w;
    for (const a of agents) d.agents[a.id] = a;
    d.windowsBySession[session.id] = windows.map((w) => w.id);
    d.agentsBySession[session.id] = agents.map((a) => a.id);
    d.activeSessionId = session.id;
    d.zoomedPaneId = null;
    d.pickerOpen = false;
}

function dirtyPathsForWindow(st: StoreState, win: Window | undefined): string[] {
    if (!win) return [];
    return collectPanes(win.root).flatMap((p) => st.dirtyEditorPaths[p.id] ?? []);
}

function dirtyPathsForPane(st: StoreState, paneId: string): string[] {
    return st.dirtyEditorPaths[paneId] ?? [];
}

function dirtyPathsForSession(st: StoreState, sessionId: string): string[] {
    const winIds = st.windowsBySession[sessionId] ?? [];
    return winIds.flatMap((id) => dirtyPathsForWindow(st, st.windows[id]));
}

function confirmDiscardDirty(paths: string[], action: string): boolean {
    if (paths.length === 0) return true;
    const shown = paths.slice(0, 3).map(basename).join(", ");
    const more = paths.length > 3 ? ` and ${paths.length - 3} more` : "";
    const ok = window.confirm(`Discard unsaved changes in ${shown}${more}?`);
    if (!ok) notify("info", `${action} cancelled — unsaved changes remain`);
    return ok;
}

export function createProjectSession(cwd: string): void {
    mutate((d) => {
        const existing = d.sessionOrder.map((id) => d.sessions[id]).find((s) => s.cwd === cwd && s.kind === "project");
        if (existing) {
            d.pickerOpen = false;
            d.zoomedPaneId = null;
            d.activeSessionId = existing.id;
            return;
        }
        const windows = projectWindows(cwd);
        attachSession(d as unknown as StoreState, makeSession("project", basename(cwd), cwd, windows[0].id), windows);
    });
}

export function createCommandSession(): void {
    mutate((d) => {
        const used = new Set<number>();
        for (const id of d.sessionOrder) {
            const s = d.sessions[id];
            if (s.kind === "command") {
                const n = parseInt(s.name, 10);
                if (Number.isFinite(n)) used.add(n);
            }
        }
        let n = 1;
        while (used.has(n)) n += 1;
        const win = makeWindow("", String(n));
        attachSession(d as unknown as StoreState, makeSession("command", String(n), "", win.id), [win]);
    });
}

export function createSshSession(alias: string): void {
    mutate((d) => {
        const existing = d.sessionOrder.map((id) => d.sessions[id]).find((s) => s.kind === "ssh" && s.name === alias);
        if (existing) {
            d.pickerOpen = false;
            d.zoomedPaneId = null;
            d.activeSessionId = existing.id;
            return;
        }
        const win = makeWindow("", alias, { startup: `ssh ${alias}`, role: "named" });
        attachSession(d as unknown as StoreState, makeSession("ssh", alias, "", win.id), [win]);
    });
}

function openSingletonPaneSession(kind: "aws" | "rundeck"): void {
    mutate((d) => {
        const existing = d.sessionOrder.map((id) => d.sessions[id]).find((s) => s.kind === kind);
        if (existing) {
            d.activeSessionId = existing.id;
            d.zoomedPaneId = null;
            return;
        }
        const win = makeWindow("", kind, { kind, role: kind, fixed: true });
        attachSession(d as unknown as StoreState, makeSession(kind, kind, "", win.id), [win]);
    });
}

export const openAwsSession = (): void => openSingletonPaneSession("aws");
export const openRundeckSession = (): void => openSingletonPaneSession("rundeck");

/** Prompt for a collection directory, then open it as a Bruno API workspace. */
export async function openBrunoFolder(): Promise<void> {
    try {
        const dir = await openDialog({ directory: true, multiple: false, title: "Open Bruno workspace" });
        if (typeof dir === "string") openBrunoSession(dir);
    } catch (e) {
        reportError("open bruno workspace")(e);
    }
}

/** Open (or focus) a Bruno API workspace for a collection directory. */
export function openBrunoSession(collectionPath: string): void {
    mutate((d) => {
        const existing = d.sessionOrder
            .map((id) => d.sessions[id])
            .find((s) => s.kind === "bruno" && s.bruno?.collectionPath === collectionPath);
        if (existing) {
            d.activeSessionId = existing.id;
            d.zoomedPaneId = null;
            d.pickerOpen = false;
            return;
        }
        const name = basename(collectionPath);
        const win = makeWindow(collectionPath, name, { kind: "bruno", role: "bruno", fixed: true });
        const session = makeSession("bruno", name, collectionPath, win.id);
        session.bruno = { collectionPath, selectedEnvs: {}, secretVars: {}, drafts: {} };
        attachSession(d as unknown as StoreState, session, [win]);
    });
}

function patchBrunoView(sessionId: string, patch: Partial<BrunoView>): void {
    mutate((d) => {
        const cur = d.brunoViews[sessionId] ?? DEFAULT_BRUNO_VIEW;
        d.brunoViews[sessionId] = { ...cur, ...patch };
    });
}

/** Open a request in a tab (adding it if not already open) and activate it. */
export function brunoSelectRequest(sessionId: string, path: string | null): void {
    mutate((d) => {
        const cur = d.brunoViews[sessionId] ?? DEFAULT_BRUNO_VIEW;
        if (path == null) {
            d.brunoViews[sessionId] = { ...cur, activeRequestPath: null };
            return;
        }
        const openPaths = cur.openPaths.includes(path) ? cur.openPaths : [...cur.openPaths, path];
        d.brunoViews[sessionId] = { ...cur, openPaths, activeRequestPath: path };
    });
}

/** Close an open request tab; if it was active, activate a neighbour. Unsaved drafts are kept. */
export function brunoCloseTab(sessionId: string, path: string): void {
    mutate((d) => {
        const cur = d.brunoViews[sessionId];
        if (!cur) return;
        const idx = cur.openPaths.indexOf(path);
        if (idx === -1) return;
        const openPaths = cur.openPaths.filter((p) => p !== path);
        let activeRequestPath = cur.activeRequestPath;
        if (activeRequestPath === path) activeRequestPath = openPaths[Math.min(idx, openPaths.length - 1)] ?? null;
        d.brunoViews[sessionId] = { ...cur, openPaths, activeRequestPath };
    });
}
export function brunoSetReqTab(sessionId: string, tab: BrunoReqTab): void {
    patchBrunoView(sessionId, { reqTab: tab });
}
export function brunoSetResTab(sessionId: string, tab: BrunoResTab): void {
    patchBrunoView(sessionId, { resTab: tab });
}
export function brunoToggleSecrets(sessionId: string, open?: boolean): void {
    mutate((d) => {
        const cur = d.brunoViews[sessionId] ?? DEFAULT_BRUNO_VIEW;
        d.brunoViews[sessionId] = { ...cur, secretsOpen: open ?? !cur.secretsOpen };
    });
}
export function brunoSelectEnv(sessionId: string, collectionPath: string, envId: string | null): void {
    mutate((d) => {
        const s = d.sessions[sessionId];
        if (s?.kind !== "bruno" || !s.bruno) return;
        if (!s.bruno.selectedEnvs) s.bruno.selectedEnvs = {};
        if (envId) s.bruno.selectedEnvs[collectionPath] = envId;
        else delete s.bruno.selectedEnvs[collectionPath];
    });
}
export function brunoSetSecret(sessionId: string, name: string, value: string): void {
    mutate((d) => {
        const s = d.sessions[sessionId];
        if (s?.kind === "bruno" && s.bruno) s.bruno.secretVars[name] = value;
    });
}
/** Stash edited (unsaved) request text by file path; pass null to clear the draft. */
export function brunoSetDraft(sessionId: string, path: string, text: string | null): void {
    mutate((d) => {
        const s = d.sessions[sessionId];
        if (s?.kind !== "bruno" || !s.bruno) return;
        if (text == null) delete s.bruno.drafts[path];
        else s.bruno.drafts[path] = text;
    });
}

/** Write the draft for a request back to its .bru file, then clear the draft. */
export async function brunoSaveRequest(sessionId: string, path: string): Promise<void> {
    const s = getState().sessions[sessionId];
    if (s?.kind !== "bruno" || !s.bruno) return;
    const draft = s.bruno.drafts[path];
    if (draft == null) return;
    const collectionPath = s.bruno.collectionPath;
    try {
        await fsapi.writeFile(path, draft);
        brunoSetDraft(sessionId, path, null);
        invalidate((kind, args) => kind === "bruno.collection" && args[0] === collectionPath);
        notify("success", `Saved ${basename(path)}`);
    } catch (e) {
        reportError("save request")(e);
    }
}

/** Save the active request of the active Bruno session (⌘S). */
export function brunoSaveActive(): void {
    const st = getState();
    const s = st.sessions[st.activeSessionId];
    if (s?.kind !== "bruno") return;
    const path = st.brunoViews[s.id]?.activeRequestPath;
    if (path) void brunoSaveRequest(s.id, path);
}

const reloadBruno = (collectionPath: string): void => invalidate((kind, args) => kind === "bruno.collection" && args[0] === collectionPath);
const safeFileName = (name: string): string => name.trim().replace(/[\\/:*?"<>|]/g, "_");

/** Create a new .bru request under a directory and select it. */
export async function brunoNewRequest(sessionId: string, dirPath: string, name: string): Promise<void> {
    const s = getState().sessions[sessionId];
    if (s?.kind !== "bruno" || !s.bruno || !name.trim()) return;
    const file = `${dirPath}/${safeFileName(name)}.bru`;
    try {
        await fsapi.writeFileNew(file, serializeRequest(emptyRequest(name.trim())));
        reloadBruno(s.bruno.collectionPath);
        brunoSelectRequest(sessionId, file);
        notify("success", `Created ${name.trim()}`);
    } catch (e) {
        reportError("create request")(e);
    }
}

/** Create a new subfolder (with a folder.bru) under a directory. */
export async function brunoNewFolder(sessionId: string, parentPath: string, name: string): Promise<void> {
    const s = getState().sessions[sessionId];
    if (s?.kind !== "bruno" || !s.bruno || !name.trim()) return;
    const folder = `${parentPath}/${safeFileName(name)}`;
    try {
        await fsapi.createDir(folder);
        await fsapi.writeFileNew(`${folder}/folder.bru`, `meta {\n  name: ${name.trim()}\n}\n`);
        reloadBruno(s.bruno.collectionPath);
        notify("success", `Created folder ${name.trim()}`);
    } catch (e) {
        reportError("create folder")(e);
    }
}

/** Rename a request: update its meta.name and move the file to match. */
export async function brunoRenameRequest(sessionId: string, path: string, name: string): Promise<void> {
    const s = getState().sessions[sessionId];
    if (s?.kind !== "bruno" || !s.bruno || !name.trim()) return;
    const newPath = `${dirname(path)}/${safeFileName(name)}.bru`;
    try {
        const text = s.bruno.drafts[path] ?? (await fsapi.readFile(path));
        const req = parseRequest(text);
        req.meta.name = name.trim();
        if (newPath === path) await fsapi.writeFile(path, serializeRequest(req));
        else {
            await fsapi.writeFileNew(newPath, serializeRequest(req));
            await fsapi.deletePath(path);
        }
        brunoSetDraft(sessionId, path, null);
        reloadBruno(s.bruno.collectionPath);
        // keep the tab pointing at the renamed file
        mutate((d) => {
            const v = d.brunoViews[sessionId];
            if (!v) return;
            v.openPaths = v.openPaths.map((p) => (p === path ? newPath : p));
            if (v.activeRequestPath === path) v.activeRequestPath = newPath;
        });
        notify("success", `Renamed to ${name.trim()}`);
    } catch (e) {
        reportError("rename request")(e);
    }
}

/** Delete a request file from disk. */
export async function brunoDeleteRequest(sessionId: string, path: string): Promise<void> {
    const s = getState().sessions[sessionId];
    if (s?.kind !== "bruno" || !s.bruno) return;
    try {
        await fsapi.deletePath(path);
        brunoSetDraft(sessionId, path, null);
        reloadBruno(s.bruno.collectionPath);
        brunoCloseTab(sessionId, path);
        notify("success", `Deleted ${basename(path)}`);
    } catch (e) {
        reportError("delete request")(e);
    }
}

const rundeckView = (st: StoreState, paneId: string): RundeckView => st.rundeckViews[paneId] ?? { stack: [{ kind: "matrix" }] };

export function rundeckPush(paneId: string, level: RundeckLevel): void {
    mutate((d) => {
        const cur = rundeckView(d as unknown as StoreState, paneId);
        d.rundeckViews[paneId] = { stack: [...cur.stack, level] };
    });
}

export function rundeckReplace(paneId: string, level: RundeckLevel): void {
    mutate((d) => {
        const cur = rundeckView(d as unknown as StoreState, paneId);
        const stack = cur.stack.slice(0, -1);
        stack.push(level);
        d.rundeckViews[paneId] = { stack };
    });
}

export function rundeckPop(paneId: string): void {
    mutate((d) => {
        const cur = rundeckView(d as unknown as StoreState, paneId);
        if (cur.stack.length <= 1) return;
        d.rundeckViews[paneId] = { stack: cur.stack.slice(0, -1) };
    });
}

export function rundeckPopTo(paneId: string, index: number): void {
    mutate((d) => {
        const cur = rundeckView(d as unknown as StoreState, paneId);
        const target = Math.max(0, Math.min(index, cur.stack.length - 1));
        d.rundeckViews[paneId] = { stack: cur.stack.slice(0, target + 1) };
    });
}

export function rundeckHome(paneId: string): void {
    mutate((d) => {
        d.rundeckViews[paneId] = { stack: [{ kind: "matrix" }] };
    });
}

function setRundeckProject(project: string, envFolder: string | null = null): void {
    mutate((d) => {
        d.rundeck.activeProject = project;
        d.rundeck.activeEnvFolder = envFolder;
    });
}

export function selectRundeckProject(paneId: string, project: string, envFolder: string | null = null): void {
    setRundeckProject(project, envFolder);
    rundeckHome(paneId);
}

/** Open the Rundeck session straight to a known service deploy (project + env folder). */
export function openRundeckService(target: { project: string; service: string; jobId: string; group: string | null }): void {
    const before = getState();
    const sourceSession = before.sessions[before.activeSessionId];
    const sourceRepoPath = sourceSession?.kind === "project" ? sourceSession.cwd : "";
    openRundeckSession();
    const after = getState();
    const sess = Object.values(after.sessions).find((s) => s.kind === "rundeck");
    if (!sess) return;
    const win = after.windows[sess.activeWindowId];
    if (!win || win.root.type !== "pane") return;
    const paneId = win.root.id;
    setRundeckProject(target.project, envFolderOf(target.group));
    rundeckReplaceStack(paneId, [
        { kind: "matrix" },
        {
            kind: "service",
            env: inferEnv(target.project, target.group),
            project: target.project,
            service: target.service,
            jobId: target.jobId,
            repoPath: sourceRepoPath,
        },
    ]);
}

function rundeckReplaceStack(paneId: string, stack: RundeckLevel[]): void {
    mutate((d) => {
        d.rundeckViews[paneId] = { stack };
    });
}

export function selectSession(id: string): void {
    mutate((d) => {
        if (!d.sessions[id]) return;
        d.activeSessionId = id;
        d.zoomedPaneId = null;
        d.pickerOpen = false;
        d.settingsOpen = false;
    });
}

export function closeSession(id: string): void {
    if (!confirmDiscardDirty(dirtyPathsForSession(getState(), id), "close session")) return;
    const closingCwd = getState().sessions[id]?.cwd;
    mutate((d) => {
        if (d.sessionOrder.length <= 1) return;
        const closed = d.sessions[id];
        if (!closed) return;
        const idx = d.sessionOrder.indexOf(id);
        const winIds = d.windowsBySession[id] ?? [];
        const agentIds = d.agentsBySession[id] ?? [];

        for (const wid of winIds) {
            const w = d.windows[wid];
            if (w) {
                for (const p of collectPanes(w.root as unknown as Window["root"])) {
                    if (d.gitModal?.ownerPaneId === p.id) d.gitModal = null;
                    delete d.editorViews[p.id];
                    delete d.dirtyEditorPaths[p.id];
                    delete d.gitViews[p.id];
                    delete d.ecsViews[p.id];
                }
            }
            delete d.windows[wid];
        }
        for (const aid of agentIds) delete d.agents[aid];
        delete d.windowsBySession[id];
        delete d.agentsBySession[id];
        delete d.brunoViews[id];
        delete d.sessions[id];
        d.sessionOrder = d.sessionOrder.filter((x) => x !== id);

        if (d.activeSessionId === id) {
            d.activeSessionId = d.sessionOrder[Math.min(idx, d.sessionOrder.length - 1)];
        }
        if (closed.kind !== "command") {
            d.recent = [{ kind: closed.kind, name: closed.name, cwd: closed.cwd }, ...d.recent.filter((r) => r.cwd !== closed.cwd)].slice(0, 12);
        }
        d.zoomedPaneId = null;
    });
    if (closingCwd) {
        const stillOpen = Object.values(getState().sessions).some((s) => s.cwd === closingCwd);
        if (!stillOpen) {
            void lsp.stop(closingCwd).catch(() => {});
        }
    }
}

export function closeActiveSession(): void {
    closeSession(getState().activeSessionId);
}

export function cycleSession(delta: number): void {
    mutate((d) => {
        const cur = d.sessions[d.activeSessionId];
        if (!cur) return;
        const groupIds = d.sessionOrder.filter((id) => d.sessions[id].kind === cur.kind);
        if (groupIds.length < 2) return;
        const idx = groupIds.indexOf(cur.id);
        d.activeSessionId = groupIds[(idx + delta + groupIds.length) % groupIds.length];
        d.zoomedPaneId = null;
    });
}

const GROUP_ORDER: SessionKind[] = ["project", "ssh", "aws", "rundeck", "bruno", "command"];

export function cycleSessionGroup(delta: number): void {
    mutate((d) => {
        const cur = d.sessions[d.activeSessionId];
        if (!cur) return;
        const populated = GROUP_ORDER.filter((kind) => d.sessionOrder.some((id) => d.sessions[id]?.kind === kind));
        if (populated.length < 2) return;
        const curIdx = populated.indexOf(cur.kind);
        if (curIdx === -1) return;
        const nextKind = populated[(curIdx + delta + populated.length) % populated.length];
        const nextId = d.sessionOrder.find((id) => d.sessions[id]?.kind === nextKind);
        if (!nextId) return;
        d.activeSessionId = nextId;
        d.zoomedPaneId = null;
    });
}

export function setDeployTarget(target: DeployRef | null): void {
    patchSession(getState().activeSessionId, (s) => ({ ...s, deploy: target }));
}

export function splitActivePane(dir: SplitDir): void {
    withActiveWindow((d, w, session) => {
        const np = makePane(session.cwd);
        const win = d.windows[w.id];
        if (!win) return;
        win.root = splitPane(w.root, w.activePaneId, dir, np);
        win.activePaneId = np.id;
        d.zoomedPaneId = null;
    });
}

function closeActivePane(): void {
    withActiveWindow((d, w, session) => {
        const closingPaneId = w.activePaneId;
        if (d.gitModal?.ownerPaneId === closingPaneId) d.gitModal = null;
        const root = removePane(w.root, closingPaneId);
        if (root === null && w.fixed) return;
        d.zoomedPaneId = null;
        delete d.editorViews[closingPaneId];
        delete d.dirtyEditorPaths[closingPaneId];
        delete d.gitViews[closingPaneId];
        delete d.ecsViews[closingPaneId];
        delete d.rundeckViews[closingPaneId];
        if (root === null) {
            const winIds = d.windowsBySession[session.id] ?? [];
            if (winIds.length <= 1) {
                const fresh = makeWindow(session.cwd, w.name);
                delete d.windows[w.id];
                d.windows[fresh.id] = fresh;
                d.windowsBySession[session.id] = [fresh.id];
                d.sessions[session.id].activeWindowId = fresh.id;
                return;
            }
            const idx = winIds.indexOf(w.id);
            const remaining = winIds.filter((id) => id !== w.id);
            const nextId = remaining[Math.min(idx, remaining.length - 1)];
            delete d.windows[w.id];
            d.windowsBySession[session.id] = remaining;
            d.sessions[session.id].activeWindowId = nextId;
            return;
        }
        const remaining = collectPanes(root);
        const win = d.windows[w.id];
        if (!win) return;
        win.root = root;
        win.activePaneId = remaining[0].id;
    });
}

function pruneWindowViews(d: StoreState, win: Window): void {
    for (const p of collectPanes(win.root)) {
        if (d.gitModal?.ownerPaneId === p.id) d.gitModal = null;
        delete d.editorViews[p.id];
        delete d.dirtyEditorPaths[p.id];
        delete d.gitViews[p.id];
        delete d.ecsViews[p.id];
        delete d.rundeckViews[p.id];
    }
}

function replaceWithFreshTerminalTab(d: StoreState, session: Session, closing: Window): void {
    const winIds = d.windowsBySession[session.id] ?? [];
    const fresh = makeWindow(session.cwd, closing.name, {
        fixed: closing.fixed,
        role: "term",
    });
    pruneWindowViews(d, closing);
    delete d.windows[closing.id];
    d.windows[fresh.id] = fresh;
    d.windowsBySession[session.id] = winIds.map((id) => (id === closing.id ? fresh.id : id));
    const sess = d.sessions[session.id];
    sess.activeWindowId = fresh.id;
    sess.view = "windows";
    d.zoomedPaneId = null;
}

function closeActiveTerminalTab(): void {
    withActiveSession((d, session) => {
        if (session.view !== "windows") return;
        const closing = d.windows[session.activeWindowId];
        if (!closing || closing.role !== "term") return;

        const winIds = d.windowsBySession[session.id] ?? [];
        const termIds = winIds.filter((id) => d.windows[id]?.role === "term");
        if (termIds.length <= 1) {
            replaceWithFreshTerminalTab(d, session, closing);
            return;
        }

        const idx = winIds.indexOf(closing.id);
        const remaining = winIds.filter((id) => id !== closing.id);
        const isTerm = (id: string) => d.windows[id]?.role === "term";
        const before = remaining.slice(0, idx).reverse().find(isTerm);
        const after = remaining.slice(idx).find(isTerm);
        const nextId = before ?? after ?? remaining[Math.min(idx, remaining.length - 1)];

        pruneWindowViews(d, closing);
        delete d.windows[closing.id];
        d.windowsBySession[session.id] = remaining;
        const sess = d.sessions[session.id];
        sess.activeWindowId = nextId;
        sess.view = "windows";
        d.zoomedPaneId = null;
    });
}

// Agent view only ever applies to project sessions; other groups may carry a
// stale `view: "agent"` but must be treated as windowed everywhere.
const inAgentView = (s: Session): boolean => s.kind === "project" && s.view === "agent";

export function closeActiveFocusTarget(): void {
    const st = getState();
    const session = st.sessions[st.activeSessionId];
    if (!session) return;

    if (inAgentView(session)) {
        if (session.activeAgentId) closeAgent(session.activeAgentId);
        return;
    }

    if (session.kind === "bruno") {
        // ⌥W closes the active request tab, not the whole Bruno workspace.
        const path = st.brunoViews[session.id]?.activeRequestPath;
        if (path) brunoCloseTab(session.id, path);
        return;
    }

    const win = st.windows[session.activeWindowId];
    if (win && collectPanes(win.root).length > 1) {
        if (!confirmDiscardDirty(dirtyPathsForPane(st, win.activePaneId), "close pane")) return;
        closeActivePane();
        return;
    }

    if (session.kind === "command") {
        closeSession(session.id);
        return;
    }

    if (win?.role === "term") {
        closeActiveTerminalTab();
        return;
    }

    closeActivePane();
}

export function focusPane(paneId: string): void {
    withActiveWindow((d, w) => {
        const win = d.windows[w.id];
        if (win) win.activePaneId = paneId;
    });
}

export function moveFocus(dir: FocusDir): void {
    withActiveWindow((d, w) => {
        const { panes } = computeLayout(w.root);
        const next = neighborPane(panes, w.activePaneId, dir);
        if (!next) return;
        const win = d.windows[w.id];
        if (win) win.activePaneId = next;
    });
}

export function resizeActivePane(dir: FocusDir): void {
    withActiveWindow((d, w) => {
        const win = d.windows[w.id];
        if (win) win.root = resizeTowards(w.root, w.activePaneId, dir);
    });
}

export function toggleZoom(): void {
    withActiveSession((d, session) => {
        if (d.zoomedPaneId) {
            d.zoomedPaneId = null;
            return;
        }
        if (session.view !== "windows") return;
        const w = d.windows[session.activeWindowId];
        if (w) d.zoomedPaneId = w.activePaneId;
    });
}

export function setSplitSizes(windowId: string, splitId: string, sizes: number[]): void {
    patchWindow(windowId, (w) => ({
        ...w,
        root: setSplitSizesFn(w.root, splitId, sizes),
    }));
}

export function newWindow(): void {
    withActiveSession((d, session) => {
        const winIds = d.windowsBySession[session.id] ?? [];
        const w = makeWindow(session.cwd, String(winIds.length + 1));
        d.windows[w.id] = w;
        d.windowsBySession[session.id] = [...winIds, w.id];
        const sess = d.sessions[session.id];
        sess.activeWindowId = w.id;
        sess.view = "windows";
        d.zoomedPaneId = null;
    });
}

export function closeWindowById(id: string): void {
    const st = getState();
    const closing = st.windows[id];
    if (!closing || closing.fixed) return;
    if (!confirmDiscardDirty(dirtyPathsForWindow(st, closing), "close window")) return;
    withActiveSession((d, session) => {
        const winIds = d.windowsBySession[session.id] ?? [];
        if (!winIds.includes(id) || winIds.length <= 1) return;
        const closing = d.windows[id];
        if (!closing || closing.fixed) return;
        const idx = winIds.indexOf(id);
        const remaining = winIds.filter((wid) => wid !== id);
        const sess = d.sessions[session.id];
        if (sess.activeWindowId === id) {
            let nextId = remaining[Math.min(idx, remaining.length - 1)];
            if (closing.role === "term") {
                const isTerm = (wid: string) => d.windows[wid]?.role === "term";
                const before = remaining.slice(0, idx).reverse().find(isTerm);
                const after = remaining.slice(idx).find(isTerm);
                nextId = before ?? after ?? nextId;
            }
            sess.activeWindowId = nextId;
        }
        pruneWindowViews(d, closing);
        delete d.windows[id];
        d.windowsBySession[session.id] = remaining;
        d.zoomedPaneId = null;
    });
}

export function closeActiveWindow(): void {
    const session = getState().sessions[getState().activeSessionId];
    if (session) closeWindowById(session.activeWindowId);
}

export function selectWindowId(id: string): void {
    withActiveSession((d, session) => {
        const winIds = d.windowsBySession[session.id] ?? [];
        if (!winIds.includes(id)) return;
        const sess = d.sessions[session.id];
        if (sess.activeWindowId === id && sess.view === "windows" && d.zoomedPaneId === null) {
            return;
        }
        sess.activeWindowId = id;
        sess.view = "windows";
        d.zoomedPaneId = null;
    });
}

export function selectWindowByIndex(index: number): void {
    const st = getState();
    const session = st.sessions[st.activeSessionId];
    const id = (st.windowsBySession[session?.id ?? ""] ?? [])[index];
    if (id) selectWindowId(id);
}

export function selectWindowByName(name: string): void {
    const st = getState();
    const session = st.sessions[st.activeSessionId];
    if (!session) return;
    const ids = st.windowsBySession[session.id] ?? [];
    const id = ids.find((wid) => st.windows[wid]?.name === name);
    if (id) selectWindowId(id);
}

const PROJECT_SLOT_ORDER: (WindowRole | "agents")[] = ["files", "term", "git", "agents", "search"];

export function selectWindowRelative(delta: number): void {
    const st = getState();
    const session = st.sessions[st.activeSessionId];
    if (!session) return;
    const winIds = st.windowsBySession[session.id] ?? [];
    const agentIds = st.agentsBySession[session.id] ?? [];

    if (session.kind !== "project") {
        if (winIds.length < 2) return;
        const idx = winIds.indexOf(session.activeWindowId);
        const next = winIds[(idx + delta + winIds.length) % winIds.length];
        selectWindowId(next);
        return;
    }

    const activeWin = st.windows[session.activeWindowId];
    const winForRole = (role: WindowRole): string | undefined => {
        if (activeWin?.role === role) return activeWin.id;
        return winIds.find((id) => st.windows[id]?.role === role);
    };

    type Slot = { kind: "win"; role: WindowRole; id: string } | { kind: "agents" };
    const slots: Slot[] = [];
    for (const slot of PROJECT_SLOT_ORDER) {
        if (slot === "agents") {
            if (agentIds.length > 0) slots.push({ kind: "agents" });
        } else {
            const id = winForRole(slot);
            if (id) slots.push({ kind: "win", role: slot, id });
        }
    }
    if (slots.length < 2) return;

    let idx: number;
    if (session.view === "agent") {
        idx = slots.findIndex((s) => s.kind === "agents");
    } else {
        const currentRole = activeWin?.role;
        idx = slots.findIndex((s) => s.kind === "win" && s.role === currentRole);
    }
    if (idx < 0) idx = 0;

    const next = slots[(idx + delta + slots.length) % slots.length];
    if (next.kind === "agents") {
        focusAgents();
    } else {
        selectWindowId(next.id);
    }
}

export function cycleAgent(delta: number): void {
    mutate((d) => {
        const session = d.sessions[d.activeSessionId];
        if (!session) return;
        const ids = d.agentsBySession[session.id] ?? [];
        if (ids.length < 2) return;
        const idx = session.activeAgentId ? ids.indexOf(session.activeAgentId) : -1;
        const base = idx < 0 ? 0 : idx;
        const sess = d.sessions[session.id];
        sess.activeAgentId = ids[(base + delta + ids.length) % ids.length];
        sess.view = "agent";
        d.zoomedPaneId = null;
    });
}

/** ⌥./⌥, — cycle whichever tab strip is currently on screen: agent tabs, terminal
 *  tabs, or the focused editor pane's open file tabs. */
export function cycleTabs(delta: number): void {
    const st = getState();
    const session = st.sessions[st.activeSessionId];
    if (!session) return;

    if (inAgentView(session)) {
        cycleAgent(delta);
        return;
    }

    if (session.kind === "bruno") {
        const open = st.brunoViews[session.id]?.openPaths ?? [];
        if (open.length < 2) return;
        const active = st.brunoViews[session.id]?.activeRequestPath;
        const idx = active ? open.indexOf(active) : -1;
        const base = idx < 0 ? 0 : idx;
        brunoSelectRequest(session.id, open[(base + delta + open.length) % open.length]);
        return;
    }

    const win = st.windows[session.activeWindowId];
    if (!win) return;

    if (win.role === "term") {
        const termIds = (st.windowsBySession[session.id] ?? []).filter((id) => st.windows[id]?.role === "term");
        if (termIds.length < 2) return;
        const idx = termIds.indexOf(win.id);
        selectWindowId(termIds[(idx + delta + termIds.length) % termIds.length]);
        return;
    }

    const pane = collectPanes(win.root).find((p) => p.id === win.activePaneId);
    if (pane?.kind !== "editor") return;
    const tabs = st.editorViews[pane.id]?.openTabs ?? [];
    if (tabs.length < 2) return;
    const active = st.editorViews[pane.id]?.activePath;
    const idx = active ? tabs.indexOf(active) : -1;
    const base = idx < 0 ? 0 : idx;
    setEditorView(pane.id, { activePath: tabs[(base + delta + tabs.length) % tabs.length] });
}

const SKIP_PERMISSION_FLAG: Partial<Record<AgentType, string>> = {
    claude: "--dangerously-skip-permissions",
    hermes: "--yolo",
    codex: "--dangerously-bypass-approvals-and-sandbox",
};

const AGENT_RESUME_CMD: Partial<Record<AgentType, (id: string) => string>> = {
    claude: (id) => `claude --resume ${id}`,
    codex: (id) => `codex resume ${id}`,
    hermes: (id) => `hermes --resume ${id}`,
    pi: (id) => `pi --session ${id}`,
    opencode: (id) => `opencode --session ${id}`,
};

const FALLBACK_AGENT_TITLE_MAX = 13;

export function agentSupportsSkipPermissions(type: AgentType): boolean {
    return SKIP_PERMISSION_FLAG[type] != null;
}

function shellQuote(value: string): string {
    if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value;
    return `'${value.replace(/'/g, "'\\''")}'`;
}

function agentStartup(type: AgentType, resumeId?: string, skipPermissions = false): string {
    const cmd = resumeId ? (AGENT_RESUME_CMD[type]?.(shellQuote(resumeId)) ?? type) : type;
    const skipFlag = SKIP_PERMISSION_FLAG[type];
    return skipPermissions && skipFlag ? `${cmd} ${skipFlag}` : cmd;
}

function usableAgentSessionTitle(row: AgentSession, current: string): string {
    const title = row.title.trim();
    if (!title) return current;
    if (title.length <= FALLBACK_AGENT_TITLE_MAX && row.id.startsWith(title)) return current;
    return title;
}

function refreshAgentBookmarkTitle(d: { agentBookmarks: AgentBookmark[] }, type: AgentType, oldId: string, newId: string, title: string): void {
    const bookmark = d.agentBookmarks.find((b) => b.type === type && b.id === oldId);
    if (!bookmark) return;
    bookmark.id = newId;
    bookmark.title = title;
}

export function toggleAgentSkipPermissions(id: string): void {
    mutate((d) => {
        const a = d.agents[id];
        if (!a) return;
        if (!agentSupportsSkipPermissions(a.type)) return;
        const next = !a.skipPermissions;
        a.skipPermissions = next;
        a.startup = agentStartup(a.type, a.resumeId, next);
    });
}

export function addAgent(type: AgentType, resumeId?: string, title?: string): void {
    withActiveSession((d, session) => {
        if (session.kind !== "project") return;
        const ownedIds = d.agentsBySession[session.id] ?? [];
        const existing = resumeId ? ownedIds.map((id) => d.agents[id]).find((a) => a && a.type === type && a.resumeId === resumeId) : undefined;
        const sess = d.sessions[session.id];
        d.zoomedPaneId = null;
        if (existing) {
            sess.activeAgentId = existing.id;
            sess.view = "agent";
            return;
        }
        const agent: Agent = {
            id: newId("agent"),
            type,
            title: title ?? type,
            startup: agentStartup(type, resumeId),
            resumeId,
            createdAt: Date.now(),
        };
        // Fresh agents (no resumeId) record the sessions that already exist so
        // reconciliation never adopts the session you were just in. The rail
        // keeps this list warm; on a cold cache we fall back to an mtime check.
        if (!resumeId) {
            const known = peekResource(agentSessionsR, type, session.cwd);
            if (known) agent.baselineSessionIds = known.map((row) => row.id);
        }
        d.agents[agent.id] = agent;
        d.agentsBySession[session.id] = [...ownedIds, agent.id];
        sess.activeAgentId = agent.id;
        sess.view = "agent";
    });
}

export function reconcileAgentSessions(type: AgentType, cwd: string, rows: AgentSession[]): void {
    if (rows.length === 0) return;
    mutate((d) => {
        const rowById = new Map(rows.map((row) => [row.id, row]));
        const matchingAgents: Agent[] = [];
        for (const sessionId of d.sessionOrder) {
            const session = d.sessions[sessionId];
            if (session?.kind !== "project" || session.cwd !== cwd) continue;
            for (const agentId of d.agentsBySession[sessionId] ?? []) {
                const agent = d.agents[agentId];
                if (agent?.type === type) matchingAgents.push(agent);
            }
        }
        if (matchingAgents.length === 0) return;

        const claimed = new Set<string>();
        for (const agent of matchingAgents) {
            if (!agent.resumeId) continue;
            claimed.add(agent.resumeId);
            const row = rowById.get(agent.resumeId);
            if (!row) continue;
            const nextTitle = usableAgentSessionTitle(row, agent.title);
            if (nextTitle !== agent.title) {
                agent.title = nextTitle;
                refreshAgentBookmarkTitle(d, type, agent.resumeId, agent.resumeId, nextTitle);
            }
        }

        const candidates = rows
            .filter((row) => !claimed.has(row.id))
            .sort((a, b) => b.mtime - a.mtime);
        if (candidates.length === 0) return;

        const freshAgents = matchingAgents
            .filter((agent) => !agent.resumeId)
            .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
        for (const agent of freshAgents) {
            // Only adopt a session that didn't exist when this agent launched,
            // otherwise it grabs the session you were just in and renames its
            // tab. `baselineSessionIds` is the snapshot taken at creation; when
            // it's missing (legacy agent / cold cache) fall back to "written at
            // or after launch", since a genuinely new session file appears
            // post-launch — never before.
            const baseline = agent.baselineSessionIds;
            const launchedAt = Math.floor((agent.createdAt ?? Date.now()) / 1000);
            const idx = candidates.findIndex((row) => (baseline ? !baseline.includes(row.id) : row.mtime >= launchedAt));
            if (idx < 0) continue;
            const [row] = candidates.splice(idx, 1);
            const oldBookmarkId = agent.id;
            agent.resumeId = row.id;
            agent.title = usableAgentSessionTitle(row, agent.title);
            agent.startup = agentStartup(agent.type, agent.resumeId, agent.skipPermissions ?? false);
            delete agent.baselineSessionIds;
            claimed.add(row.id);
            refreshAgentBookmarkTitle(d, type, oldBookmarkId, row.id, agent.title);
        }
    });
}

export function selectAgent(id: string): void {
    withActiveSession((d, session) => {
        const sess = d.sessions[session.id];
        sess.activeAgentId = id;
        sess.view = "agent";
    });
}

export function closeAgent(id: string): void {
    mutate((d) => {
        const ownerId = d.sessionOrder.find((sid) => (d.agentsBySession[sid] ?? []).includes(id));
        if (!ownerId) return;
        const owner = d.sessions[ownerId];
        const ownedIds = (d.agentsBySession[ownerId] ?? []).filter((aid) => aid !== id);
        const wasActive = owner.activeAgentId === id;
        delete d.agents[id];
        d.agentsBySession[ownerId] = ownedIds;
        if (wasActive) {
            owner.activeAgentId = ownedIds[0] ?? null;
            if (ownedIds.length === 0) owner.view = "windows";
        }
    });
}

export function focusAgents(): void {
    // Agents only exist in project sessions. Other groups (bruno, aws, rundeck,
    // ssh, command) have no agents and no way back out of "agent" view, so the
    // agent shortcuts (⌥/, ⌥C, ⌥4) are a no-op there.
    if (getState().sessions[getState().activeSessionId]?.kind !== "project") return;
    withActiveSession((d, session) => {
        const ids = d.agentsBySession[session.id] ?? [];
        const sess = d.sessions[session.id];
        sess.view = "agent";
        sess.activeAgentId = session.activeAgentId ?? ids[0] ?? null;
        d.zoomedPaneId = null;
    });
    emit({ type: "agent-focus", sessionId: getState().activeSessionId });
}

export function toggleAgentBookmark(b: AgentBookmark): void {
    mutate((d) => {
        const idx = d.agentBookmarks.findIndex((x) => x.type === b.type && x.id === b.id);
        if (idx >= 0) {
            d.agentBookmarks.splice(idx, 1);
        } else {
            d.agentBookmarks.unshift(b);
        }
    });
}

export function openAgentBookmark(b: AgentBookmark): void {
    const st = getState();
    for (const id of st.sessionOrder) {
        const sess = st.sessions[id];
        if (sess.kind !== "project") continue;
        const ownedIds = st.agentsBySession[id] ?? [];
        const live = ownedIds.map((aid) => st.agents[aid]).find((a) => a && a.type === b.type && a.resumeId === b.id);
        if (live) {
            mutate((d) => {
                d.activeSessionId = id;
                d.zoomedPaneId = null;
                const sess = d.sessions[id];
                sess.activeAgentId = live.id;
                sess.view = "agent";
            });
            return;
        }
    }

    if (b.cwd) {
        const cur = getState();
        const existing = cur.sessionOrder.map((id) => cur.sessions[id]).find((s) => s.kind === "project" && s.cwd === b.cwd);
        if (existing) {
            if (existing.id !== cur.activeSessionId) {
                setState({ activeSessionId: existing.id, zoomedPaneId: null });
            }
        } else {
            createProjectSession(b.cwd);
        }
    }

    const isFreshBookmark = b.id.startsWith("agent-");
    if (!isFreshBookmark) {
        const cur = getState();
        const dest = cur.sessions[cur.activeSessionId];
        if (dest && dest.kind === "project") {
            const ownedIds = cur.agentsBySession[dest.id] ?? [];
            const freshs = ownedIds.map((aid) => cur.agents[aid]).filter((a) => a && a.type === b.type && !a.resumeId);
            if (freshs.length === 1) {
                const fresh = freshs[0]!;
                mutate((d) => {
                    const a = d.agents[fresh.id];
                    if (a) {
                        a.resumeId = b.id;
                        a.title = b.title;
                    }
                    const sess = d.sessions[dest.id];
                    if (sess) {
                        sess.activeAgentId = fresh.id;
                        sess.view = "agent";
                    }
                });
                return;
            }
        }
    }

    if (isFreshBookmark) addAgent(b.type);
    else addAgent(b.type, b.id, b.title);
}

export const setHome = (home: string): void => setState({ home });
export const openPicker = (mode: PickerMode = "all"): void => setState({ pickerOpen: true, pickerMode: mode, rundeckJobPaletteOpen: false });
export const closePicker = (): void => setState({ pickerOpen: false });
export const openAgentPalette = (): void => setState({ agentPaletteOpen: true, rundeckJobPaletteOpen: false });
export const closeAgentPalette = (): void => setState({ agentPaletteOpen: false });
export const openFilePalette = (): void => setState({ filePaletteOpen: true, rundeckJobPaletteOpen: false });
export const closeFilePalette = (): void => setState({ filePaletteOpen: false });
export const openRundeckJobPalette = (): void =>
    setState({ rundeckJobPaletteOpen: true, pickerOpen: false, filePaletteOpen: false, agentPaletteOpen: false });
export const closeRundeckJobPalette = (): void => setState({ rundeckJobPaletteOpen: false });
export const openBrunoReqPalette = (): void =>
    setState({ brunoReqPaletteOpen: true, brunoEnvPaletteOpen: false, filePaletteOpen: false, agentPaletteOpen: false, pickerOpen: false });
export const closeBrunoReqPalette = (): void => setState({ brunoReqPaletteOpen: false });
export const openBrunoEnvPalette = (): void =>
    setState({ brunoEnvPaletteOpen: true, brunoReqPaletteOpen: false, filePaletteOpen: false, agentPaletteOpen: false, pickerOpen: false });
export const closeBrunoEnvPalette = (): void => setState({ brunoEnvPaletteOpen: false });
export const openSettings = (): void => setState({ settingsOpen: true });
export const closeSettings = (): void => setState({ settingsOpen: false });
export const toggleSettings = (): void => setState((s) => ({ settingsOpen: !s.settingsOpen }));
export const toggleLeftRail = (): void => setState((s) => ({ leftRailOpen: !s.leftRailOpen }));
export const toggleRightRail = (): void => setState((s) => ({ rightRailOpen: !s.rightRailOpen }));
export const toggleZen = (): void => setState((s) => ({ zenMode: !s.zenMode }));

function focusSessionWindowRole(role: WindowRole): void {
    withActiveSession((d, session) => {
        const target = (d.windowsBySession[session.id] ?? []).find((id) => d.windows[id]?.role === role);
        if (!target) return;
        if (session.activeWindowId === target && session.view === "windows" && d.zoomedPaneId === null) return;
        d.zoomedPaneId = null;
        const sess = d.sessions[session.id];
        sess.activeWindowId = target;
        sess.view = "windows";
    });
}

export function requestOpenFile(path: string, line?: number, character?: number): void {
    focusSessionWindowRole("files");
    emit({ type: "open-file", path, line, character });
}

export function openGitPane(): void {
    focusSessionWindowRole("git");
}

export function setThemeId(id: string): void {
    applyTheme(id);
    setState({ themeId: id });
}

export function setWindowOpacity(v: number): void {
    const value = Number.isFinite(v) ? v : 1;
    applyWindowOpacity(value);
    setState({ windowOpacity: value });
}

export function setWindowBlur(v: number): void {
    const value = Number.isFinite(v) ? Math.round(v) : 0;
    void invoke("set_window_blur", { radius: value }).catch(swallow("set_window_blur"));
    setState({ windowBlur: value });
}

export const setCloudBrowser = (v: string): void => setState({ cloudBrowser: v.trim() });
export const setCloudBrowserShortcut = (v: string): void => setState({ cloudBrowserShortcut: v.trim() });

export function addProjectRoot(path: string, depth = 1): void {
    setState((s) => (s.projectRoots.some((r) => r.path === path) ? {} : { projectRoots: [...s.projectRoots, { path, depth }] }));
    invalidate((kind) => kind === projectRootsScanR.kind);
}

export function addPinnedProject(path: string): void {
    setState((s) => (s.pinnedProjects.some((p) => p.path === path) ? {} : { pinnedProjects: [...s.pinnedProjects, { path }] }));
    invalidate((kind) => kind === projectRootsScanR.kind);
}

export function removePinnedProject(path: string): void {
    setState((s) => ({
        pinnedProjects: s.pinnedProjects.filter((p) => p.path !== path),
    }));
    invalidate((kind) => kind === projectRootsScanR.kind);
}

export function removeProjectRoot(path: string): void {
    setState((s) => ({
        projectRoots: s.projectRoots.filter((r) => r.path !== path),
    }));
    invalidate((kind) => kind === projectRootsScanR.kind);
}

export function setProjectRootDepth(path: string, depth: number): void {
    const d = Math.max(0, Math.round(Number.isFinite(depth) ? depth : 1));
    setState((s) => ({
        projectRoots: s.projectRoots.map((r) => (r.path === path ? { ...r, depth: d } : r)),
    }));
    invalidate((kind) => kind === projectRootsScanR.kind);
}

export function normaliseProjectRoots(raw: unknown): ProjectRoot[] {
    if (!Array.isArray(raw)) return [];
    return raw
        .map((r): ProjectRoot | null => {
            if (typeof r === "string") return { path: r, depth: 1 };
            if (r && typeof r === "object" && typeof (r as ProjectRoot).path === "string") {
                const depth = (r as ProjectRoot).depth;
                return {
                    path: (r as ProjectRoot).path,
                    depth: Number.isFinite(depth) ? Math.max(0, Math.round(depth)) : 1,
                };
            }
            return null;
        })
        .filter((x): x is ProjectRoot => x !== null);
}

export function normalisePinnedProjects(raw: unknown): PinnedProject[] {
    if (!Array.isArray(raw)) return [];
    return raw
        .map((p): PinnedProject | null => {
            if (typeof p === "string") return { path: p };
            if (p && typeof p === "object" && typeof (p as PinnedProject).path === "string") {
                return { path: (p as PinnedProject).path };
            }
            return null;
        })
        .filter((x): x is PinnedProject => x !== null);
}

export const setAwsProfile = (name: string | null): void => setState({ awsProfile: name });
export const setAwsService = (s: AwsService): void => setState({ awsService: s });
export const openAwsAuthModal = (profile: string, ssoStartUrl: string | null): void => setState({ awsAuthModal: { profile, ssoStartUrl } });
export const closeAwsAuthModal = (): void => setState({ awsAuthModal: null });

export async function runAwsSsoLogin(profile: string): Promise<boolean> {
    const result = await awsApi.ssoLogin(profile);
    if (result.success) {
        invalidate((kind, args) => kind === awsIdentityR.kind && args[0] === profile);
        await fetchResource(awsIdentityR, profile, true).catch(swallow("awsIdentityR refetch"));
    }
    return result.success;
}

export function setEditorView(paneId: string, patch: Partial<StoreState["editorViews"][string]>): void {
    mutate((d) => {
        const cur = d.editorViews[paneId] ?? {
            openTabs: [],
            activePath: null,
            treeWidth: 210,
        };
        d.editorViews[paneId] = { ...cur, ...patch };
    });
}

export function setEditorDirtyPaths(paneId: string, paths: string[]): void {
    mutate((d) => {
        if (paths.length === 0) delete d.dirtyEditorPaths[paneId];
        else d.dirtyEditorPaths[paneId] = paths;
    });
}

export function setGitView(paneId: string, patch: Partial<StoreState["gitViews"][string]>): void {
    mutate((d) => {
        const cur = (d.gitViews[paneId] ?? DEFAULT_GIT_VIEW) as StoreState["gitViews"][string];
        d.gitViews[paneId] = { ...cur, ...patch };
    });
}

export function setEcsLevel(paneId: string, level: EcsLevel): void {
    mutate((d) => {
        d.ecsViews[paneId] = level;
    });
}

export function setBillingExpandedMonth(profile: string, month: string | null): void {
    mutate((d) => {
        d.expandedBillingMonth[profile] = month;
    });
}

function searchViewFor(sessionId: string) {
    const st = getState();
    return st.globalSearchBySession[sessionId] ?? DEFAULT_GLOBAL_SEARCH_VIEW;
}

export function focusGlobalSearch(seed?: string): void {
    const st = getState();
    const session = st.sessions[st.activeSessionId];
    if (!session || session.kind !== "project") return;
    if (seed && seed.trim().length > 0) {
        const oneLine = seed.split(/\r?\n/).find((l) => l.trim().length > 0) ?? seed.trim();
        setGlobalSearchQuery(session.id, oneLine);
    }
    const ids = st.windowsBySession[session.id] ?? [];
    const target = ids.find((id) => st.windows[id]?.role === "search");
    if (target) selectWindowId(target);
    emit({ type: "search-focus", sessionId: session.id });
}

export function setGlobalSearchQuery(sessionId: string, query: string): void {
    const cur = searchViewFor(sessionId);
    mutate((d) => {
        d.globalSearchBySession[sessionId] = { ...cur, query };
    });
}

export function setGlobalSearchOption<K extends keyof typeof DEFAULT_GLOBAL_SEARCH_VIEW.options>(
    sessionId: string,
    key: K,
    value: (typeof DEFAULT_GLOBAL_SEARCH_VIEW.options)[K],
): void {
    const cur = searchViewFor(sessionId);
    mutate((d) => {
        d.globalSearchBySession[sessionId] = {
            ...cur,
            options: { ...cur.options, [key]: value },
        };
    });
}

export function toggleGlobalSearchFileCollapsed(sessionId: string, path: string): void {
    const cur = searchViewFor(sessionId);
    const wasCollapsed = !!cur.collapsed[path];
    const next = { ...cur.collapsed };
    if (wasCollapsed) delete next[path];
    else next[path] = true;
    mutate((d) => {
        d.globalSearchBySession[sessionId] = { ...cur, collapsed: next };
    });
}

export function setGlobalSearchReplace(sessionId: string, replace: string): void {
    const cur = searchViewFor(sessionId);
    mutate((d) => {
        d.globalSearchBySession[sessionId] = { ...cur, replace };
    });
}

export function setGlobalSearchSelected(sessionId: string, selected: { path: string; matchIndex: number } | null): void {
    const cur = searchViewFor(sessionId);
    mutate((d) => {
        d.globalSearchBySession[sessionId] = { ...cur, selected };
    });
}

export function toggleGlobalSearchReplaceOpen(sessionId: string): void {
    const cur = searchViewFor(sessionId);
    mutate((d) => {
        d.globalSearchBySession[sessionId] = { ...cur, replaceOpen: !cur.replaceOpen };
    });
}

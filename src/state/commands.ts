import { invoke } from "@tauri-apps/api/core";
import { awsApi } from "../api/aws";
import { lsp } from "../api/lsp";
import { rundeckApi } from "../api/rundeck";
import { applyTheme, applyWindowOpacity } from "../themes/bus";
import { emit } from "./bus";
import { fetchResource, invalidate, peekResource } from "./resources";
import { awsIdentityR, projectRootsScanR, rndProjectsR } from "./resources.defs";
import { inferEnv } from "./rundeckShape";
import { getState, mutate, setState, type StoreState } from "./store";
import { swallow } from "./toast";
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
    EcsLevel,
    Env,
    FocusDir,
    GitPanel,
    PickerMode,
    ProjectRoot,
    RecentEntry,
    RundeckLevel,
    RundeckView,
    Session,
    SessionKind,
    SplitDir,
    Window,
    WindowRole,
} from "./types";

// All write operations on the store. Components do not call setState
// directly; they call cmd.X(). Each command does exactly what it says
// and emits at most one bus event for cross-component coordination.
//
// Convention: small functions, kept in feature groups for navigation.
// Closures over getState/setState — no slice ceremony.
//
// TODO(C4 split): this file is ~1300 lines and 79 exports. Planned split,
// keeping this file as the barrel for back-compat:
//
//   commands/_shared.ts   — patchSession, patchWindow, withActiveSession,
//                           withActiveWindow, basename, makeWindow,
//                           projectWindows, attachSession (private helpers)
//   commands/session.ts   — createX session, selectSession, closeSession,
//                           cycleSession{,Group}, togglePin, reopenRecent,
//                           setEnv
//   commands/pane.ts      — splitActivePane, closeActivePane, focusPane,
//                           moveFocus, resizeActivePane, toggleZoom,
//                           setSplitSizes
//   commands/window.ts    — newWindow, closeActiveWindow, selectWindowId,
//                           selectWindowByIndex, selectWindowByName,
//                           selectWindowRelative, ensureSearchWindow
//   commands/agent.ts     — addAgent, selectAgent, closeAgent,
//                           toggleAgentSkipPermissions, focusAgents,
//                           toggle/openAgentBookmark
//   commands/rundeck.ts   — openRundeckSession, rundeckPush/Pop/Replace/
//                           Home, setRundeckProject, openRundeckServiceFor
//   commands/aws.ts       — setAwsProfile, setAwsService, runAwsSsoLogin,
//                           openAwsAuthModal, closeAwsAuthModal
//   commands/prefs.ts     — setThemeId, setWindowOpacity, setWindowBlur,
//                           setCloudBrowser{,Shortcut}, addProjectRoot,
//                           removeProjectRoot, setProjectRootDepth,
//                           normaliseProjectRoots
//   commands/view.ts      — setEditorView, setGitView, setEcsLevel,
//                           setBillingExpandedMonth
//   commands/search.ts    — focusGlobalSearch, setGlobalSearchQuery,
//                           setGlobalSearchOption,
//                           toggle/expand/collapseAllGlobalSearchFiles
//   commands/ui.ts        — setHome, open/close{Picker,AgentPalette,
//                           FilePalette,Settings}, toggleSettings,
//                           toggleLeft/RightRail, openLspResults,
//                           closeLspResults, requestOpenFile
//
// Do not start the split alongside other in-flight work — it touches
// every component that does `import * as cmd from "../state/commands"`.

// `patchSession`/`patchWindow` used to spread-rebuild the entity map on
// every call. Now they hand the entity to an immer draft and let the
// draft handle structural sharing. Callers still write a pure
// transformation (`s => ({ ...s, name: x })`) because that's the local
// vocabulary used 50+ times in this file — the immer benefit lives at
// the parent-map level where most allocations happened.
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

// Most mutations want "with the active session, if there is one, do X" or
// "with the active window, if there is one, do X". The immer draft form
// lets the body just mutate the draft in place — no patch return, no
// shallow-spread ceremony at the call site.
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

const basename = (p: string): string => p.replace(/\/+$/, "").split("/").pop() || p;

// ---- Layout primitives -------------------------------------------------

function makeWindow(
    cwd: string,
    name: string,
    opts: {
        kind?: "terminal" | "editor" | "git" | "search";
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

function projectWindows(cwd: string): Window[] {
    return [
        makeWindow(cwd, "files", { kind: "editor", fixed: true, role: "files" }),
        makeWindow(cwd, "term", { fixed: true, role: "term" }),
        makeWindow(cwd, "git", { kind: "git", fixed: true, role: "git" }),
        makeWindow(cwd, "search", { kind: "search", fixed: true, role: "search" }),
    ];
}

/** Append a search window to a project session that doesn't have one yet.
 *  Used by persist.applyHydrate to migrate snapshots created before the
 *  search-pane was introduced. */
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

// ---- Sessions ---------------------------------------------------------

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
        const session: Session = {
            id: newId("sess"),
            name: basename(cwd),
            kind: "project",
            cwd,
            env: "dev",
            pinned: false,
            activeWindowId: windows[0].id,
            activeAgentId: null,
            view: "windows",
        };
        attachSession(d as unknown as StoreState, session, windows);
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
        const session: Session = {
            id: newId("sess"),
            name: String(n),
            kind: "command",
            cwd: "",
            env: "dev",
            pinned: false,
            activeWindowId: win.id,
            activeAgentId: null,
            view: "windows",
        };
        attachSession(d as unknown as StoreState, session, [win]);
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
        const session: Session = {
            id: newId("sess"),
            name: alias,
            kind: "ssh",
            cwd: "",
            env: "dev",
            pinned: false,
            activeWindowId: win.id,
            activeAgentId: null,
            view: "windows",
        };
        attachSession(d as unknown as StoreState, session, [win]);
    });
}

export function openAwsSession(): void {
    mutate((d) => {
        const existing = d.sessionOrder.map((id) => d.sessions[id]).find((s) => s.kind === "aws");
        if (existing) {
            d.activeSessionId = existing.id;
            d.zoomedPaneId = null;
            return;
        }
        const pane = makePane("", { kind: "aws" });
        const win: Window = {
            id: newId("win"),
            name: "aws",
            role: "aws",
            root: pane,
            activePaneId: pane.id,
            fixed: true,
        };
        const session: Session = {
            id: newId("sess"),
            name: "aws",
            kind: "aws",
            cwd: "",
            env: "dev",
            pinned: false,
            activeWindowId: win.id,
            activeAgentId: null,
            view: "windows",
        };
        attachSession(d as unknown as StoreState, session, [win]);
    });
}

export function openRundeckSession(): void {
    mutate((d) => {
        const existing = d.sessionOrder.map((id) => d.sessions[id]).find((s) => s.kind === "rundeck");
        if (existing) {
            d.activeSessionId = existing.id;
            d.zoomedPaneId = null;
            return;
        }
        const pane = makePane("", { kind: "rundeck" });
        const win: Window = {
            id: newId("win"),
            name: "rundeck",
            role: "rundeck",
            root: pane,
            activePaneId: pane.id,
            fixed: true,
        };
        const session: Session = {
            id: newId("sess"),
            name: "rundeck",
            kind: "rundeck",
            cwd: "",
            env: "dev",
            pinned: false,
            activeWindowId: win.id,
            activeAgentId: null,
            view: "windows",
        };
        attachSession(d as unknown as StoreState, session, [win]);
    });
}

// ---- Rundeck per-pane navigation -----------------------------------------

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

/** Pane-level project selector (Rundeck pane only). The picker offers
 *  every project Rundeck returns — legacy + product — no aliasing.
 *  `envFolder` narrows a product project to a specific env subtree
 *  (`dev/backend/...`); pass `null` to show every env folder grouped.
 *  Legacy projects ignore the env-folder filter regardless. */
export function setRundeckProject(project: string, envFolder: string | null = null): void {
    mutate((d) => {
        d.rundeck.activeProject = project;
        d.rundeck.activeEnvFolder = envFolder;
    });
}

/** Tree-click selector: switch the active project AND pop the per-pane
 *  nav stack back to the matrix. Without the reset, switching projects
 *  while inside a deploy/execution detail would leave you on a detail
 *  page that no longer matches the project label in the breadcrumb. */
export function selectRundeckProject(paneId: string, project: string, envFolder: string | null = null): void {
    setRundeckProject(project, envFolder);
    rundeckHome(paneId);
}

/** From a project session: jump to the Rundeck service detail (execution
 *  history) for (basename(cwd), session.env). Resolves env → Rundeck
 *  project by matching name against the live upstream project list —
 *  no alias table. If the user has e.g. a `staging` project upstream,
 *  envLabel "staging" finds it; if not, the chip just doesn't fire. */
export async function openRundeckServiceFor(service: string, envLabel: string): Promise<void> {
    const before = getState();
    const sourceSession = before.sessions[before.activeSessionId];
    const sourceRepoPath = sourceSession?.kind === "project" ? sourceSession.cwd : "";
    // Ensure the projects list is in cache (cheap if already loaded).
    const projects = (await fetchResource(rndProjectsR).catch(() => null)) ?? peekResource(rndProjectsR) ?? [];
    const envLower = envLabel.toLowerCase();
    const project = projects.find((p) => p.name.toLowerCase() === envLower)?.name;
    if (!project) return;
    openRundeckSession();
    const after = getState();
    const sess = Object.values(after.sessions).find((s) => s.kind === "rundeck");
    if (!sess) return;
    const win = after.windows[sess.activeWindowId];
    if (!win || win.root.type !== "pane") return;
    const paneId = win.root.id;
    // Sync the pane's project so the picker reflects where we landed.
    setRundeckProject(project);
    try {
        const job = await rundeckApi.resolveJob(project, service);
        rundeckReplaceStack(paneId, [
            { kind: "matrix" },
            {
                kind: "service",
                env: inferEnv(project, job.group),
                project,
                service,
                jobId: job.id,
                repoPath: sourceRepoPath,
            },
        ]);
    } catch {
        // Service doesn't exist in this project — drop them at the matrix.
        rundeckReplaceStack(paneId, [{ kind: "matrix" }]);
    }
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
        // Clicking a session always returns you to the workspace — settings
        // is modal in spirit even though it lives in the stage. Closing here
        // matches every other session-switch.
        d.settingsOpen = false;
    });
}

export function closeSession(id: string): void {
    // Capture cwd before mutate so we can shut down the project's LSP
    // servers after the store update — LSP servers are per (project,
    // language) keyed by cwd, and they live forever otherwise.
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
                    delete d.editorViews[p.id];
                    delete d.gitViews[p.id];
                    delete d.ecsViews[p.id];
                }
            }
            delete d.windows[wid];
        }
        for (const aid of agentIds) delete d.agents[aid];
        delete d.windowsBySession[id];
        delete d.agentsBySession[id];
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
    // Reap LSP servers owned by this project — only if no other still-open
    // session shares the same cwd. rust-analyzer / pyright are heavy; left
    // running, they add up to GBs across a busy session.
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

// Order matching the SideRail group blocks. Pinned isn't a group of its
// own — pinned sessions still belong to their original kind, they just
// also surface in the Superpin block. Cycling jumps from one kind to the
// next, landing on the first session of that kind.
const GROUP_ORDER: SessionKind[] = ["project", "ssh", "aws", "rundeck", "command"];

/** Jump to the first session of the next/previous SessionKind group
 *  (Projects → SSH → Cloud → CI/CD → Command → wrap). Skips empty groups. */
export function cycleSessionGroup(delta: number): void {
    mutate((d) => {
        const cur = d.sessions[d.activeSessionId];
        if (!cur) return;
        // Find non-empty groups in the canonical order, preserving the
        // SessionKind sequence the user sees on the rail.
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

export function togglePin(id: string): void {
    mutate((d) => {
        const s = d.sessions[id];
        if (s) s.pinned = !s.pinned;
    });
}

export function reopenRecent(entry: RecentEntry): void {
    createProjectSession(entry.cwd);
    mutate((d) => {
        d.recent = d.recent.filter((r) => r.cwd !== entry.cwd);
    });
}

export function setEnv(env: Env): void {
    patchSession(getState().activeSessionId, (s) => ({ ...s, env }));
}

// ---- Layout / panes ---------------------------------------------------

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

export function closeActivePane(): void {
    withActiveWindow((d, w, session) => {
        const root = removePane(w.root, w.activePaneId);
        if (root === null && w.fixed) return;
        d.zoomedPaneId = null;
        if (root === null) {
            const winIds = d.windowsBySession[session.id] ?? [];
            if (winIds.length <= 1) {
                // Last window — reset to a fresh terminal in place.
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
        delete d.editorViews[p.id];
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

export function closeActiveTerminalTab(): void {
    withActiveSession((d, session) => {
        if (session.view !== "windows") return;
        const closing = d.windows[session.activeWindowId];
        if (!closing || closing.role !== "term") return;

        const winIds = d.windowsBySession[session.id] ?? [];
        const termIds = winIds.filter((id) => d.windows[id]?.role === "term");
        if (termIds.length <= 1) {
            // Keep every session with one usable terminal target. This mirrors
            // closing the last tab in terminal apps that immediately leave a
            // fresh shell behind instead of removing the whole terminal surface.
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

export function closeActiveFocusTarget(): void {
    const st = getState();
    const session = st.sessions[st.activeSessionId];
    if (!session) return;

    if (session.view === "agent") {
        if (session.activeAgentId) closeAgent(session.activeAgentId);
        return;
    }

    if (session.kind === "command") {
        closeSession(session.id);
        return;
    }

    const win = st.windows[session.activeWindowId];
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

// ---- Windows / tabs ---------------------------------------------------

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

export function closeActiveWindow(): void {
    withActiveSession((d, session) => {
        const closing = d.windows[session.activeWindowId];
        if (!closing || closing.fixed) return;
        const winIds = d.windowsBySession[session.id] ?? [];
        if (winIds.length <= 1) return;
        const idx = winIds.indexOf(closing.id);
        const remaining = winIds.filter((id) => id !== closing.id);
        // When closing a term tab, prefer to land on another term tab so the
        // user's attention stays inside the terminal stack.
        let nextId = remaining[Math.min(idx, remaining.length - 1)];
        if (closing.role === "term") {
            const isTerm = (id: string) => d.windows[id]?.role === "term";
            const before = remaining.slice(0, idx).reverse().find(isTerm);
            const after = remaining.slice(idx).find(isTerm);
            nextId = before ?? after ?? nextId;
        }
        // Prune pane views that lived in the closing window.
        pruneWindowViews(d, closing);
        delete d.windows[closing.id];
        d.windowsBySession[session.id] = remaining;
        d.sessions[session.id].activeWindowId = nextId;
        d.zoomedPaneId = null;
    });
}

export function selectWindowId(id: string): void {
    withActiveSession((d, session) => {
        const winIds = d.windowsBySession[session.id] ?? [];
        if (!winIds.includes(id)) return;
        const sess = d.sessions[session.id];
        // No-op when we're already exactly here. Skipping the writes avoids
        // an unnecessary store notification, which fans out to every Workspace
        // subscriber on the hot Alt+]/[ cycling path.
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

/** Display order of the project's pane "slots" for Alt+./Alt+, cycling.
 *  Mirrors the SideRail's expanded child list so the rail and the cycle
 *  agree on what "next pane" means. `agents` isn't a window role — it's
 *  the synthetic agent-view slot, present when the project has any
 *  running agents. */
const PROJECT_SLOT_ORDER: (WindowRole | "agents")[] = ["files", "term", "git", "agents", "search"];

/** Cycle to the next/previous pane in the active project. Visits each
 *  role exactly once (so multi-tab term sessions don't make `term` show
 *  up N times) and includes the synthetic Agents slot when agents are
 *  running. For non-project sessions falls back to a plain windowsBySession
 *  walk. */
export function selectWindowRelative(delta: number): void {
    const st = getState();
    const session = st.sessions[st.activeSessionId];
    if (!session) return;
    const winIds = st.windowsBySession[session.id] ?? [];
    const agentIds = st.agentsBySession[session.id] ?? [];

    // Non-project sessions don't carry the fixed role layout; cycle their
    // raw window list as before.
    if (session.kind !== "project") {
        if (winIds.length < 2) return;
        const idx = winIds.indexOf(session.activeWindowId);
        const next = winIds[(idx + delta + winIds.length) % winIds.length];
        selectWindowId(next);
        return;
    }

    // Pick the representative window id for each role slot. For term we
    // honor the currently-active term tab so cycling away and back returns
    // to the same tab instead of snapping to tab #1.
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

    // Locate the current cursor: either an agents slot (view==agent) or
    // the slot whose role matches the active window.
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

// ---- Agents -----------------------------------------------------------

// Skip-approval / yolo flags per agent. Mirrors `<cli> --help` (claude:
// --dangerously-skip-permissions, hermes: --yolo, codex:
// --dangerously-bypass-approvals-and-sandbox).
const SKIP_PERMISSION_FLAG: Record<AgentType, string> = {
    claude: "--dangerously-skip-permissions",
    hermes: "--yolo",
    codex: "--dangerously-bypass-approvals-and-sandbox",
};

function agentStartup(type: AgentType, resumeId?: string, skipPermissions = false): string {
    let cmd: string;
    if (!resumeId) cmd = type;
    else if (type === "claude") cmd = `claude --resume ${resumeId}`;
    else if (type === "codex") cmd = `codex resume ${resumeId}`;
    else if (type === "hermes") cmd = `hermes --resume ${resumeId}`;
    else cmd = type;
    return skipPermissions ? `${cmd} ${SKIP_PERMISSION_FLAG[type]}` : cmd;
}

/** Toggle the agent's runtime skip-permissions flag and remount its PTY
 *  so the new startup line takes effect. The React key in Workspace's
 *  AgentLayer includes `skipPermissions`, so a state flip naturally
 *  triggers unmount → fresh spawn. Persists across reloads. */
export function toggleAgentSkipPermissions(id: string): void {
    mutate((d) => {
        const a = d.agents[id];
        if (!a) return;
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
        };
        d.agents[agent.id] = agent;
        d.agentsBySession[session.id] = [...ownedIds, agent.id];
        sess.activeAgentId = agent.id;
        sess.view = "agent";
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
    // 1. Already running? Jump to its owner.
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

    // 2. Switch to bookmark's project (existing or new).
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

    // 3. Link to a fresh agent of the same type if exactly one exists.
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

    // 4. Spawn.
    if (isFreshBookmark) addAgent(b.type);
    else addAgent(b.type, b.id, b.title);
}

// ---- UI flags ---------------------------------------------------------

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
export const openSettings = (): void => setState({ settingsOpen: true });
export const closeSettings = (): void => setState({ settingsOpen: false });
export const toggleSettings = (): void => setState((s) => ({ settingsOpen: !s.settingsOpen }));
export const toggleLeftRail = (): void => setState((s) => ({ leftRailOpen: !s.leftRailOpen }));
export const toggleRightRail = (): void => setState((s) => ({ rightRailOpen: !s.rightRailOpen }));
// Zen / focus mode — collapses both rails without mutating their own
// open/closed prefs, so exiting zen restores the prior layout exactly.
export const toggleZen = (): void => setState((s) => ({ zenMode: !s.zenMode }));
export const openLspResults = (title: string, project: string, results: { uri: string; line: number; character: number }[]): void =>
    setState({ lspResults: { title, project, results } });
export const closeLspResults = (): void => setState({ lspResults: null });

// "Open file X" — emits an event. App.tsx subscribes and routes to the
// right session's editor pane; the EditorPane in that pane subscribes
// directly to apply the open + scroll.
export function requestOpenFile(path: string, line?: number, character?: number): void {
    // Navigate the active session to its files window if needed, so the
    // editor pane is mounted before the event fires.
    withActiveSession((d, session) => {
        const winIds = d.windowsBySession[session.id] ?? [];
        const filesId = winIds.find((id) => d.windows[id]?.role === "files");
        if (!filesId) return;
        d.zoomedPaneId = null;
        if (session.activeWindowId === filesId && session.view === "windows") return;
        const sess = d.sessions[session.id];
        sess.activeWindowId = filesId;
        sess.view = "windows";
    });
    emit({ type: "open-file", path, line, character });
}

// "Open Git" — navigate the active project session to its (fixed) git
// window. No-op for non-project sessions, which have no git window. Used
// by the top-bar branch chip.
export function openGitPane(): void {
    withActiveSession((d, session) => {
        const winIds = d.windowsBySession[session.id] ?? [];
        const gitId = winIds.find((id) => d.windows[id]?.role === "git");
        if (!gitId) return;
        d.zoomedPaneId = null;
        const sess = d.sessions[session.id];
        sess.activeWindowId = gitId;
        sess.view = "windows";
    });
}

// ---- Settings / prefs -------------------------------------------------

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

// Persist may hand us a legacy array of plain strings — normalise to the
// new shape with the default depth.
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

// ---- AWS --------------------------------------------------------------

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

// ---- View state (per-pane) -------------------------------------------

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

export function setGitView(paneId: string, patch: Partial<StoreState["gitViews"][string]>): void {
    mutate((d) => {
        const cur: StoreState["gitViews"][string] = (d.gitViews[paneId] ??
            ({
                panel: "status" as GitPanel,
                selected: { status: 0, files: 0, branches: 0, remotes: 0, commits: 0, stashes: 0 },
                remoteDrill: null,
                remoteBranchSelected: {},
            } as unknown as StoreState["gitViews"][string])) as StoreState["gitViews"][string];
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

// ---- Global search (Cmd+Shift+F) -------------------------------------

const DEFAULT_SEARCH_VIEW = {
    query: "",
    replace: "",
    replaceOpen: false,
    options: {
        caseSensitive: false,
        wholeWord: false,
        isRegex: false,
        include: "",
        exclude: "",
    },
    collapsed: {} as Record<string, boolean>,
    selected: null as { path: string; matchIndex: number } | null,
};

function searchViewFor(sessionId: string) {
    const st = getState();
    return st.globalSearchBySession[sessionId] ?? DEFAULT_SEARCH_VIEW;
}

// Navigate the active project session to its search window AND signal the
// pane to focus its find input. The event fires on every invocation — so
// pressing Cmd/Ctrl+Shift+F while already in the search window still
// pulls focus back to the input. No-op for non-project sessions.
//
// If `seed` is non-empty, write it into the per-session global-search
// query before the focus event fires — that's how we forward the active
// editor's selection (gathered in the keymap) into the search box.
export function focusGlobalSearch(seed?: string): void {
    const st = getState();
    const session = st.sessions[st.activeSessionId];
    if (!session || session.kind !== "project") return;
    if (seed && seed.trim().length > 0) {
        // Single-line trim — multi-line selections in the editor would make
        // the search input wrap weirdly, and the project search matches per
        // line anyway. First non-empty line is the most useful.
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

export function setGlobalSearchOption<K extends keyof typeof DEFAULT_SEARCH_VIEW.options>(
    sessionId: string,
    key: K,
    value: (typeof DEFAULT_SEARCH_VIEW.options)[K],
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

export function expandAllGlobalSearchFiles(sessionId: string): void {
    const cur = searchViewFor(sessionId);
    mutate((d) => {
        d.globalSearchBySession[sessionId] = { ...cur, collapsed: {} };
    });
}

export function collapseAllGlobalSearchFiles(sessionId: string, paths: string[]): void {
    const cur = searchViewFor(sessionId);
    const next: Record<string, boolean> = {};
    for (const p of paths) next[p] = true;
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

import { invoke } from "@tauri-apps/api/core";
import { sshStartup } from "../terminal/sshStartup";
import { isTheme } from "../themes";
import { registerCustomThemes } from "../themes/bus";
import { ensureSearchWindow, normalisePinnedProjects, normaliseProjectRoots } from "./commands";
import { getState, setState, useStore, type StoreState } from "./store";
import { errMessage, notify } from "./toast";
import type {
    Agent,
    AgentBookmark,
    EditorPaneView,
    PersistedPrefs,
    PersistedSession,
    PersistedSnapshot,
    RecentEntry,
    Session,
    Window,
    WindowRole,
} from "./types";

function deriveRole(w: Window): WindowRole {
    if (WINDOW_ROLES.has(w.role)) return w.role;
    if (w.name === "files") return "files";
    if (w.name === "git") return "git";
    if (w.name === "aws") return "aws";
    if (w.name === "rundeck") return "rundeck";
    if (w.name === "bruno") return "bruno";
    if (w.name === "term" || /^\d+$/.test(w.name)) return "term";
    return "named";
}

const VERSION = 4;
const MIN_SUPPORTED_VERSION = 3;
const RETRY_MS = 1500;
let lastSaved = "";
let activeSnapshot: string | null = null;
let pendingSnapshot: string | null = null;
let saveLoop: Promise<boolean> | null = null;
let retryTimer: number | undefined;
let persistTimer: number | undefined;
let persistenceReady = false;

const PERSISTED_KEYS = [
    "sessions",
    "windows",
    "agents",
    "sessionOrder",
    "windowsBySession",
    "agentsBySession",
    "activeSessionId",
    "recent",
    "agentBookmarks",
    "editorViews",
    "pinnedProjects",
    "projectRoots",
    "brunoWorkspaces",
    "themeId",
    "customThemes",
    "windowOpacity",
    "windowBlur",
    "cloudBrowser",
    "cloudBrowserShortcut",
    "awsProfile",
    "awsService",
    "leftRailOpen",
    "rightRailOpen",
    "zenMode",
    "rundeck",
] as const satisfies readonly (keyof StoreState)[];
type PersistedKey = (typeof PERSISTED_KEYS)[number];
type SliceShot = { [K in PersistedKey]: StoreState[K] };
let lastSlices: SliceShot | null = null;

function takeSlices(s: StoreState): SliceShot {
    const out = {} as SliceShot;
    for (const k of PERSISTED_KEYS) (out as Record<string, unknown>)[k] = s[k];
    return out;
}

function slicesEqual(a: SliceShot, b: SliceShot): boolean {
    for (const k of PERSISTED_KEYS) if (a[k] !== b[k]) return false;
    return true;
}

function packPrefs(s: StoreState): PersistedPrefs {
    return {
        projectRoots: s.projectRoots,
        pinnedProjects: s.pinnedProjects,
        brunoWorkspaces: s.brunoWorkspaces,
        themeId: s.themeId,
        customThemes: s.customThemes,
        windowOpacity: s.windowOpacity,
        windowBlur: s.windowBlur,
        cloudBrowser: s.cloudBrowser,
        cloudBrowserShortcut: s.cloudBrowserShortcut,
        awsProfile: s.awsProfile,
        awsService: s.awsService,
        leftRailOpen: s.leftRailOpen,
        rightRailOpen: s.rightRailOpen,
        zenMode: s.zenMode,
        rundeck: s.rundeck,
    };
}

/** Union of the persisted registry with any currently-open Bruno collection paths, deduped, most-recent-first. */
function mergeBrunoWorkspaces(saved: string[] | undefined, sessions: Session[]): string[] {
    const open = sessions.filter((s) => s.kind === "bruno").map((s) => s.bruno?.collectionPath);
    const out: string[] = [];
    for (const p of [...(saved ?? []), ...open]) if (typeof p === "string" && p && !out.includes(p)) out.push(p);
    return out;
}

const AGENT_TYPES = new Set<Agent["type"]>(["claude", "codex", "hermes", "pi", "opencode"]);
const SESSION_KINDS = new Set<Session["kind"]>(["project", "command", "ssh", "aws", "rundeck", "bruno"]);
const WINDOW_ROLES = new Set<WindowRole>(["term", "files", "git", "search", "aws", "rundeck", "bruno", "named"]);
const PANE_KINDS = new Set(["terminal", "editor", "git", "aws", "search", "rundeck", "bruno"]);
const AWS_SERVICES = new Set<StoreState["awsService"]>(["ecs", "ec2", "lambda", "sqs", "billing", "s3"]);

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
    return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}

function isAgentType(value: unknown): value is Agent["type"] {
    return typeof value === "string" && AGENT_TYPES.has(value as Agent["type"]);
}

function isPersistedAgent(value: unknown): value is Agent {
    if (!isRecord(value)) return false;
    return typeof value.id === "string" && isAgentType(value.type) && typeof value.title === "string" && typeof value.startup === "string";
}

function isLayout(value: unknown): value is Window["root"] {
    if (!isRecord(value) || typeof value.id !== "string") return false;
    if (value.type === "pane") {
        return typeof value.cwd === "string" && PANE_KINDS.has(value.kind as never) && typeof value.title === "string";
    }
    return (
        value.type === "split" &&
        (value.dir === "row" || value.dir === "column") &&
        Array.isArray(value.children) &&
        value.children.length > 0 &&
        value.children.every(isLayout) &&
        Array.isArray(value.sizes) &&
        value.sizes.length === value.children.length &&
        value.sizes.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0)
    );
}

function isWindow(value: unknown): value is Window {
    return (
        isRecord(value) &&
        typeof value.id === "string" &&
        typeof value.name === "string" &&
        typeof value.activePaneId === "string" &&
        isLayout(value.root)
    );
}

function layoutIds(root: Window["root"]): { all: string[]; panes: string[] } {
    const all: string[] = [];
    const panes: string[] = [];
    const walk = (node: Window["root"]): void => {
        all.push(node.id);
        if (node.type === "pane") panes.push(node.id);
        else node.children.forEach(walk);
    };
    walk(root);
    return { all, panes };
}

/** Upgrade SSH sessions saved before reconnect support was added. */
function upgradeSshStartup(root: Window["root"], alias: string): Window["root"] {
    if (root.type === "pane") {
        return root.kind === "terminal" && root.startup === `ssh ${alias}` ? { ...root, startup: sshStartup(alias) } : root;
    }
    const children = root.children.map((child) => upgradeSshStartup(child, alias));
    return children.some((child, i) => child !== root.children[i]) ? { ...root, children } : root;
}

function toSession(value: unknown): Session | null {
    if (!isRecord(value)) return null;
    if (
        typeof value.id !== "string" ||
        typeof value.name !== "string" ||
        !SESSION_KINDS.has(value.kind as Session["kind"]) ||
        typeof value.cwd !== "string" ||
        typeof value.pinned !== "boolean" ||
        typeof value.activeWindowId !== "string" ||
        !(value.activeAgentId === null || typeof value.activeAgentId === "string") ||
        !(value.view === "windows" || value.view === "agent")
    ) {
        return null;
    }
    const deploy =
        isRecord(value.deploy) &&
        typeof value.deploy.project === "string" &&
        (value.deploy.folder === null || typeof value.deploy.folder === "string")
            ? { project: value.deploy.project, folder: value.deploy.folder }
            : null;
    const session: Session = {
        id: value.id,
        name: value.name,
        kind: value.kind as Session["kind"],
        cwd: value.cwd,
        deploy,
        pinned: value.pinned,
        activeWindowId: value.activeWindowId,
        activeAgentId: value.activeAgentId,
        view: value.view,
    };
    if (session.kind === "bruno") {
        const bruno = isRecord(value.bruno) ? value.bruno : {};
        session.bruno = {
            collectionPath: typeof bruno.collectionPath === "string" ? bruno.collectionPath : session.cwd,
            selectedEnvs: isStringRecord(bruno.selectedEnvs) ? bruno.selectedEnvs : {},
            // Older snapshots may contain credentials. Never restore them into runtime state.
            secretVars: {},
            drafts: {},
        };
    } else {
        delete session.bruno;
    }
    return session;
}

function isEditorView(value: unknown): value is EditorPaneView {
    return (
        isRecord(value) &&
        Array.isArray(value.openTabs) &&
        value.openTabs.every((p) => typeof p === "string") &&
        (value.activePath === null || typeof value.activePath === "string") &&
        typeof value.treeWidth === "number" &&
        Number.isFinite(value.treeWidth)
    );
}

function isRecent(value: unknown): value is RecentEntry {
    return isRecord(value) && SESSION_KINDS.has(value.kind as Session["kind"]) && typeof value.name === "string" && typeof value.cwd === "string";
}

function isBookmark(value: unknown): value is AgentBookmark {
    return isRecord(value) && isAgentType(value.type) && typeof value.id === "string" && typeof value.title === "string";
}

function persistedSession(sess: Session, activeAgentId: string | null, view: Session["view"]): PersistedSession {
    const { bruno, ...base } = sess;
    if (sess.kind !== "bruno" || !bruno) return { ...base, activeAgentId, view };
    return {
        ...base,
        activeAgentId,
        view,
        bruno: { collectionPath: bruno.collectionPath, selectedEnvs: bruno.selectedEnvs },
    };
}

function snapshot(): string {
    const s = getState();
    const sessionAgentIds = new Map<string, string[]>();
    const sessions = s.sessionOrder
        .map((id) => s.sessions[id])
        .filter(Boolean)
        .map((sess) => {
            const agentIds = (s.agentsBySession[sess.id] ?? []).filter((id) => s.agents[id]);
            sessionAgentIds.set(sess.id, agentIds);
            const savedActiveAgentId = sess.activeAgentId && agentIds.includes(sess.activeAgentId) ? sess.activeAgentId : null;
            const activeAgentId = savedActiveAgentId ?? (sess.view === "agent" ? (agentIds[0] ?? null) : null);
            const view: Session["view"] = sess.view === "agent" && activeAgentId ? "agent" : "windows";
            return persistedSession(sess, activeAgentId, view);
        });
    const windowsBySession: Record<string, Window[]> = {};
    const agentsBySession: Record<string, Agent[]> = {};
    for (const sess of sessions) {
        windowsBySession[sess.id] = (s.windowsBySession[sess.id] ?? []).map((id) => s.windows[id]).filter(Boolean);
        agentsBySession[sess.id] = (sessionAgentIds.get(sess.id) ?? []).map((id) => s.agents[id]).filter(Boolean);
    }
    const snap: PersistedSnapshot = {
        version: VERSION,
        sessions,
        windowsBySession,
        agentsBySession,
        sessionOrder: sessions.map((s) => s.id),
        activeSessionId: s.activeSessionId,
        recent: s.recent,
        agentBookmarks: s.agentBookmarks,
        prefs: packPrefs(s),
        editorViews: s.editorViews,
    };
    // Defense in depth: these runtime-only Bruno fields must never reach disk,
    // even if a malformed record introduced them outside the typed session shape.
    return JSON.stringify(snap, (key, value) => (key === "secretVars" || key === "drafts" ? undefined : value));
}

function scheduleRetry(): void {
    if (retryTimer != null) return;
    retryTimer = window.setTimeout(() => {
        retryTimer = undefined;
        void startSaveLoop();
    }, RETRY_MS);
}

async function drainSaves(): Promise<boolean> {
    while (pendingSnapshot != null) {
        const current = pendingSnapshot;
        pendingSnapshot = null;
        activeSnapshot = current;
        try {
            await invoke("state_save", { data: current });
            lastSaved = current;
        } catch (error) {
            if (pendingSnapshot == null) pendingSnapshot = current;
            notify("error", `state save failed: ${errMessage(error)}; retrying`);
            scheduleRetry();
            return false;
        } finally {
            activeSnapshot = null;
        }
    }
    return true;
}

function startSaveLoop(): Promise<boolean> {
    if (saveLoop) return saveLoop;
    saveLoop = drainSaves().finally(() => {
        saveLoop = null;
    });
    return saveLoop;
}

function queueSnapshot(next: string): void {
    if (activeSnapshot != null) {
        // The active write will leave disk at activeSnapshot. If current state has
        // returned to that value, any previously queued newer value is obsolete.
        pendingSnapshot = next === activeSnapshot ? null : next;
        return;
    }
    pendingSnapshot = next === lastSaved ? null : next;
}

/** Save the latest state and wait until all currently queued writes have completed. */
export function flushPersist(): Promise<boolean> {
    if (persistTimer != null) {
        window.clearTimeout(persistTimer);
        persistTimer = undefined;
    }
    if (retryTimer != null) {
        window.clearTimeout(retryTimer);
        retryTimer = undefined;
    }
    lastSlices = takeSlices(getState());
    queueSnapshot(snapshot());
    return startSaveLoop();
}

export function applyHydrate(raw: string): void {
    if (!raw) return;
    let decoded: unknown;
    try {
        decoded = JSON.parse(raw);
    } catch {
        return;
    }
    if (!isRecord(decoded) || typeof decoded.version !== "number" || decoded.version < MIN_SUPPORTED_VERSION || decoded.version > VERSION) return;
    if (!Array.isArray(decoded.sessions)) return;

    const sessions: Record<string, Session> = {};
    for (const row of decoded.sessions) {
        const session = toSession(row);
        if (session && !sessions[session.id]) sessions[session.id] = session;
    }
    if (Object.keys(sessions).length === 0) return;

    const windows: Record<string, Window> = {};
    const agents: Record<string, Agent> = {};
    const windowsBySession: Record<string, string[]> = {};
    const agentsBySession: Record<string, string[]> = {};
    const rawWindows = isRecord(decoded.windowsBySession) ? decoded.windowsBySession : {};
    const usedLayoutIds = new Set<string>();
    for (const sid of Object.keys(sessions)) {
        const rows = Array.isArray(rawWindows[sid]) ? rawWindows[sid] : [];
        windowsBySession[sid] = [];
        for (const row of rows) {
            if (!isWindow(row) || windows[row.id]) continue;
            const ids = layoutIds(row.root);
            if (new Set(ids.all).size !== ids.all.length || ids.all.some((id) => usedLayoutIds.has(id))) continue;
            ids.all.forEach((id) => usedLayoutIds.add(id));
            windows[row.id] = {
                ...row,
                root: sessions[sid].kind === "ssh" ? upgradeSshStartup(row.root, sessions[sid].name) : row.root,
                role: deriveRole(row),
                activePaneId: ids.panes.includes(row.activePaneId) ? row.activePaneId : ids.panes[0],
            };
            windowsBySession[sid].push(row.id);
        }
        agentsBySession[sid] = [];
    }
    const rawAgents = isRecord(decoded.agentsBySession) ? decoded.agentsBySession : {};
    for (const sid of Object.keys(sessions)) {
        const rows = Array.isArray(rawAgents[sid]) ? rawAgents[sid] : [];
        for (const row of rows) {
            if (!isPersistedAgent(row) || agents[row.id]) continue;
            agents[row.id] = row;
            agentsBySession[sid].push(row.id);
        }
    }
    for (const sid of Object.keys(sessions)) {
        const session = sessions[sid];
        const agentIds = agentsBySession[sid];
        const windowIds = windowsBySession[sid];
        const savedActiveAgentId = session.activeAgentId && agentIds.includes(session.activeAgentId) ? session.activeAgentId : null;
        const activeAgentId = savedActiveAgentId ?? (session.view === "agent" ? (agentIds[0] ?? null) : null);
        sessions[sid] = {
            ...session,
            activeWindowId: windowIds.includes(session.activeWindowId) ? session.activeWindowId : (windowIds[0] ?? ""),
            activeAgentId,
            view: session.view === "agent" && activeAgentId ? "agent" : "windows",
        };
    }

    const validPaneIds = new Set<string>();
    for (const w of Object.values(windows)) {
        const walk = (n: Window["root"]): void => {
            if (n.type === "pane") validPaneIds.add(n.id);
            else n.children.forEach(walk);
        };
        walk(w.root);
    }
    const editorViews: Record<string, EditorPaneView> = {};
    const rawEditorViews = isRecord(decoded.editorViews) ? decoded.editorViews : {};
    for (const [pid, value] of Object.entries(rawEditorViews)) if (validPaneIds.has(pid) && isEditorView(value)) editorViews[pid] = value;

    const requestedOrder = Array.isArray(decoded.sessionOrder) ? decoded.sessionOrder.filter((id): id is string => typeof id === "string") : [];
    const sessionOrder = [...new Set(requestedOrder.filter((id) => sessions[id]))];
    for (const sid of Object.keys(sessions)) if (!sessionOrder.includes(sid)) sessionOrder.push(sid);
    const requestedActive = typeof decoded.activeSessionId === "string" ? decoded.activeSessionId : "";
    const activeSessionId = sessions[requestedActive] ? requestedActive : sessionOrder[0];
    const prefs = isRecord(decoded.prefs) ? decoded.prefs : {};
    const cur = getState();
    const rundeck = isRecord(prefs.rundeck) ? prefs.rundeck : {};
    const prodEnvs = Array.isArray(rundeck.prodEnvs) ? rundeck.prodEnvs.filter((v): v is string => typeof v === "string") : cur.rundeck.prodEnvs;

    setState({
        sessions,
        windows,
        agents,
        sessionOrder,
        windowsBySession,
        agentsBySession,
        activeSessionId,
        recent: Array.isArray(decoded.recent) ? decoded.recent.filter(isRecent) : [],
        agentBookmarks: Array.isArray(decoded.agentBookmarks) ? decoded.agentBookmarks.filter(isBookmark) : [],
        editorViews,
        pinnedProjects: normalisePinnedProjects(Array.isArray(prefs.pinnedProjects) ? prefs.pinnedProjects : []),
        projectRoots: Array.isArray(prefs.projectRoots) ? normaliseProjectRoots(prefs.projectRoots) : cur.projectRoots,
        brunoWorkspaces: mergeBrunoWorkspaces(
            Array.isArray(prefs.brunoWorkspaces) ? prefs.brunoWorkspaces.filter((v): v is string => typeof v === "string") : undefined,
            Object.values(sessions),
        ),
        themeId: typeof prefs.themeId === "string" ? prefs.themeId : cur.themeId,
        customThemes: Array.isArray(prefs.customThemes) ? prefs.customThemes.filter(isTheme) : cur.customThemes,
        windowOpacity: typeof prefs.windowOpacity === "number" && Number.isFinite(prefs.windowOpacity) ? prefs.windowOpacity : cur.windowOpacity,
        windowBlur: typeof prefs.windowBlur === "number" && Number.isFinite(prefs.windowBlur) ? prefs.windowBlur : cur.windowBlur,
        cloudBrowser: typeof prefs.cloudBrowser === "string" ? prefs.cloudBrowser : cur.cloudBrowser,
        cloudBrowserShortcut: typeof prefs.cloudBrowserShortcut === "string" ? prefs.cloudBrowserShortcut : cur.cloudBrowserShortcut,
        awsProfile: prefs.awsProfile === null || typeof prefs.awsProfile === "string" ? prefs.awsProfile : cur.awsProfile,
        awsService: AWS_SERVICES.has(prefs.awsService as StoreState["awsService"]) ? (prefs.awsService as StoreState["awsService"]) : cur.awsService,
        leftRailOpen: typeof prefs.leftRailOpen === "boolean" ? prefs.leftRailOpen : cur.leftRailOpen,
        rightRailOpen: typeof prefs.rightRailOpen === "boolean" ? prefs.rightRailOpen : cur.rightRailOpen,
        zenMode: typeof prefs.zenMode === "boolean" ? prefs.zenMode : cur.zenMode,
        rundeck: {
            activeProject: typeof rundeck.activeProject === "string" ? rundeck.activeProject : "",
            activeEnvFolder: rundeck.activeEnvFolder === null || typeof rundeck.activeEnvFolder === "string" ? rundeck.activeEnvFolder : null,
            prodEnvs,
        },
    });
    ensureSearchWindow();
    registerCustomThemes(getState().customThemes);
    // Preserve the actual disk payload as the saved marker. The subscription
    // rewrites migrations and sanitized legacy credentials in canonical v4 form.
    lastSaved = raw;
    lastSlices = takeSlices(getState());
}

export function canFlushPersist(): boolean {
    return persistenceReady;
}

export function subscribePersist(): () => void {
    persistenceReady = true;
    queueSnapshot(snapshot());
    void startSaveLoop();
    const unsubscribe = useStore.subscribe(() => {
        if (persistTimer != null) window.clearTimeout(persistTimer);
        persistTimer = window.setTimeout(() => {
            persistTimer = undefined;
            const slices = takeSlices(getState());
            if (lastSlices && slicesEqual(lastSlices, slices)) return;
            lastSlices = slices;
            queueSnapshot(snapshot());
            void startSaveLoop();
        }, 600);
    });
    let closed = false;
    return () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        void flushPersist();
        persistenceReady = false;
    };
}

export function resetPersistenceForTests(): void {
    if (persistTimer != null) window.clearTimeout(persistTimer);
    if (retryTimer != null) window.clearTimeout(retryTimer);
    persistTimer = undefined;
    retryTimer = undefined;
    lastSaved = "";
    activeSnapshot = null;
    pendingSnapshot = null;
    saveLoop = null;
    lastSlices = null;
    persistenceReady = false;
}

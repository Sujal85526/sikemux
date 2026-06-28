import { invoke } from "@tauri-apps/api/core";
import { isTheme } from "../themes";
import { registerCustomThemes } from "../themes/bus";
import { ensureSearchWindow, normalisePinnedProjects, normaliseProjectRoots } from "./commands";
import { getState, setState, useStore, type StoreState } from "./store";
import type { Agent, EditorPaneView, PersistedPrefs, PersistedSnapshot, Session, Window, WindowRole } from "./types";

function deriveRole(w: Window): WindowRole {
    if (w.role) return w.role;
    if (w.name === "files") return "files";
    if (w.name === "git") return "git";
    if (w.name === "aws") return "aws";
    if (w.name === "rundeck") return "rundeck";
    if (w.name === "bruno") return "bruno";
    if (w.name === "term" || /^\d+$/.test(w.name)) return "term";
    return "named";
}

const VERSION = 4;
let lastSaved = "";

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
    for (const k of PERSISTED_KEYS) {
        (out as Record<string, unknown>)[k] = s[k];
    }
    return out;
}

function slicesEqual(a: SliceShot, b: SliceShot): boolean {
    for (const k of PERSISTED_KEYS) {
        if (a[k] !== b[k]) return false;
    }
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
    };
}

/** Union of the persisted registry with any currently-open Bruno collection paths, deduped, most-recent-first. */
function mergeBrunoWorkspaces(saved: string[] | undefined, sessions: Session[]): string[] {
    const open = sessions.filter((s) => s.kind === "bruno").map((s) => s.bruno?.collectionPath);
    const out: string[] = [];
    for (const p of [...(saved ?? []), ...open]) {
        if (typeof p === "string" && p && !out.includes(p)) out.push(p);
    }
    return out;
}

const AGENT_TYPES = new Set<Agent["type"]>(["claude", "codex", "hermes", "pi", "opencode"]);

function isAgentType(value: unknown): value is Agent["type"] {
    return typeof value === "string" && AGENT_TYPES.has(value as Agent["type"]);
}

function isPersistedAgent(value: unknown): value is Agent {
    if (!value || typeof value !== "object") return false;
    const agent = value as Partial<Agent>;
    return typeof agent.id === "string" && isAgentType(agent.type) && typeof agent.title === "string" && typeof agent.startup === "string";
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
            return { ...sess, activeAgentId, view };
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
        sessionOrder: s.sessionOrder,
        activeSessionId: s.activeSessionId,
        recent: s.recent,
        agentBookmarks: s.agentBookmarks,
        prefs: packPrefs(s),
        editorViews: s.editorViews,
    };
    return JSON.stringify(snap);
}

export function applyHydrate(raw: string): void {
    if (!raw) return;
    let data: PersistedSnapshot;
    try {
        data = JSON.parse(raw) as PersistedSnapshot;
    } catch {
        return;
    }
    if (data.version !== VERSION) return;
    if (!Array.isArray(data.sessions) || data.sessions.length === 0) return;

    const sessions: Record<string, Session> = {};
    const windows: Record<string, Window> = {};
    const agents: Record<string, Agent> = {};
    const windowsBySession: Record<string, string[]> = {};
    const agentsBySession: Record<string, string[]> = {};
    for (const s of data.sessions) {
        sessions[s.id] = { ...s };
    }
    for (const [sid, ws] of Object.entries(data.windowsBySession ?? {})) {
        windowsBySession[sid] = ws.map((w) => {
            windows[w.id] = { ...w, role: deriveRole(w) };
            return w.id;
        });
    }
    for (const sid of Object.keys(sessions)) {
        agentsBySession[sid] = [];
    }
    for (const [sid, rows] of Object.entries(data.agentsBySession ?? {})) {
        if (!sessions[sid] || !Array.isArray(rows)) continue;
        const ids: string[] = [];
        for (const row of rows) {
            if (!isPersistedAgent(row) || agents[row.id]) continue;
            agents[row.id] = row;
            ids.push(row.id);
        }
        agentsBySession[sid] = ids;
    }
    for (const sid of Object.keys(sessions)) {
        const session = sessions[sid];
        const agentIds = agentsBySession[sid] ?? [];
        const savedActiveAgentId = session.activeAgentId && agentIds.includes(session.activeAgentId) ? session.activeAgentId : null;
        const activeAgentId = savedActiveAgentId ?? (session.view === "agent" ? (agentIds[0] ?? null) : null);
        sessions[sid] = {
            ...session,
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
    for (const [pid, v] of Object.entries(data.editorViews ?? {})) {
        if (validPaneIds.has(pid)) editorViews[pid] = v;
    }

    const activeSessionId = sessions[data.activeSessionId]
        ? data.activeSessionId
        : (data.sessionOrder.find((id) => sessions[id]) ?? Object.keys(sessions)[0]);

    const cur = getState();
    setState({
        sessions,
        windows,
        agents,
        sessionOrder: data.sessionOrder.filter((id) => sessions[id]),
        windowsBySession,
        agentsBySession,
        activeSessionId,
        recent: data.recent ?? [],
        agentBookmarks: data.agentBookmarks ?? [],
        editorViews,
        pinnedProjects: normalisePinnedProjects(data.prefs?.pinnedProjects),
        projectRoots: data.prefs?.projectRoots ? normaliseProjectRoots(data.prefs.projectRoots) : cur.projectRoots,
        brunoWorkspaces: mergeBrunoWorkspaces(data.prefs?.brunoWorkspaces, Object.values(sessions)),
        themeId: data.prefs?.themeId ?? cur.themeId,
        customThemes: Array.isArray(data.prefs?.customThemes) ? data.prefs.customThemes.filter(isTheme) : cur.customThemes,
        windowOpacity: data.prefs?.windowOpacity ?? cur.windowOpacity,
        windowBlur: data.prefs?.windowBlur ?? cur.windowBlur,
        cloudBrowser: data.prefs?.cloudBrowser ?? cur.cloudBrowser,
        cloudBrowserShortcut: data.prefs?.cloudBrowserShortcut ?? cur.cloudBrowserShortcut,
        awsProfile: data.prefs?.awsProfile ?? cur.awsProfile,
        awsService: data.prefs?.awsService ?? cur.awsService,
        leftRailOpen: data.prefs?.leftRailOpen ?? cur.leftRailOpen,
        rightRailOpen: data.prefs?.rightRailOpen ?? cur.rightRailOpen,
        zenMode: data.prefs?.zenMode ?? cur.zenMode,
        rundeck: (() => {
            const raw = data.prefs?.rundeck as
                | {
                      activeProject?: string;
                      activeEnvFolder?: string | null;
                      prodEnvs?: string[];
                  }
                | undefined;
            if (!raw) return cur.rundeck;
            return {
                activeProject: raw.activeProject ?? "",
                activeEnvFolder: raw.activeEnvFolder ?? null,
                prodEnvs: raw.prodEnvs ?? cur.rundeck.prodEnvs,
            };
        })(),
    });
    ensureSearchWindow();
    registerCustomThemes(getState().customThemes);
    lastSaved = snapshot();
    lastSlices = takeSlices(getState());
}

export function subscribePersist(): () => void {
    let timer: number | undefined;
    const unsubscribe = useStore.subscribe(() => {
        if (timer) window.clearTimeout(timer);
        timer = window.setTimeout(() => {
            timer = undefined;
            const slices = takeSlices(getState());
            if (lastSlices && slicesEqual(lastSlices, slices)) return;
            lastSlices = slices;

            const snap = snapshot();
            if (snap === lastSaved) return;
            lastSaved = snap;
            void invoke("mobile_sync_update_state", { data: snap });
            void invoke("state_save", { data: snap });
        }, 600);
    });
    return () => {
        if (timer) window.clearTimeout(timer);
        timer = undefined;
        unsubscribe();
    };
}

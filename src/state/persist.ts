import { invoke } from "@tauri-apps/api/core";
import { normaliseProjectRoots } from "./commands";
import { getState, setState, useStore, type StoreState } from "./store";
import type {
  Agent,
  EditorPaneView,
  PersistedPrefs,
  PersistedSnapshot,
  Session,
  Window,
} from "./types";

// Boot/save round-trip. The wire format is described by PersistedSnapshot.
// Versioned — bump VERSION when the shape changes; older blobs are ignored
// and the user gets fresh defaults.

const VERSION = 4;
let lastSaved = "";

function packPrefs(s: StoreState): PersistedPrefs {
  return {
    projectRoots: s.projectRoots,
    themeId: s.themeId,
    windowOpacity: s.windowOpacity,
    windowBlur: s.windowBlur,
    cloudBrowser: s.cloudBrowser,
    cloudBrowserShortcut: s.cloudBrowserShortcut,
    awsProfile: s.awsProfile,
    awsService: s.awsService,
    leftRailOpen: s.leftRailOpen,
    rightRailOpen: s.rightRailOpen,
  };
}

function snapshot(): string {
  const s = getState();
  const sessions = s.sessionOrder.map((id) => s.sessions[id]).filter(Boolean);
  const windowsBySession: Record<string, Window[]> = {};
  const agentsBySession: Record<string, Agent[]> = {};
  for (const sess of sessions) {
    windowsBySession[sess.id] = (s.windowsBySession[sess.id] ?? [])
      .map((id) => s.windows[id])
      .filter(Boolean);
    agentsBySession[sess.id] = (s.agentsBySession[sess.id] ?? [])
      .map((id) => s.agents[id])
      .filter(Boolean);
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

/** Hydrate the store from a raw JSON string (e.g. boot_init's return). */
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
  for (const s of data.sessions) sessions[s.id] = s;
  for (const [sid, ws] of Object.entries(data.windowsBySession ?? {})) {
    windowsBySession[sid] = ws.map((w) => {
      windows[w.id] = w;
      return w.id;
    });
  }
  for (const [sid, as] of Object.entries(data.agentsBySession ?? {})) {
    agentsBySession[sid] = as.map((a) => {
      agents[a.id] = a;
      return a.id;
    });
  }
  // Drop editor-view entries for panes that no longer exist.
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
    // Prefs — fall back to current defaults if a field is missing.
    projectRoots: data.prefs?.projectRoots
      ? normaliseProjectRoots(data.prefs.projectRoots)
      : cur.projectRoots,
    themeId: data.prefs?.themeId ?? cur.themeId,
    windowOpacity: data.prefs?.windowOpacity ?? cur.windowOpacity,
    windowBlur: data.prefs?.windowBlur ?? cur.windowBlur,
    cloudBrowser: data.prefs?.cloudBrowser ?? cur.cloudBrowser,
    cloudBrowserShortcut:
      data.prefs?.cloudBrowserShortcut ?? cur.cloudBrowserShortcut,
    awsProfile: data.prefs?.awsProfile ?? cur.awsProfile,
    awsService: data.prefs?.awsService ?? cur.awsService,
    leftRailOpen: data.prefs?.leftRailOpen ?? cur.leftRailOpen,
    rightRailOpen: data.prefs?.rightRailOpen ?? cur.rightRailOpen,
  });
  lastSaved = snapshot();
}

/** Debounced save on every store change. Returns an unsubscribe function. */
export function subscribePersist(): () => void {
  let timer: number | undefined;
  return useStore.subscribe(() => {
    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      const snap = snapshot();
      if (snap === lastSaved) return;
      lastSaved = snap;
      void invoke("state_save", { data: snap });
    }, 600);
  });
}

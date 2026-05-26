import { invoke } from "@tauri-apps/api/core";
import { ensureSearchWindow, normaliseProjectRoots } from "./commands";
import { getState, setState, useStore, type StoreState } from "./store";
import type {
  Agent,
  EditorPaneView,
  PersistedPrefs,
  PersistedSnapshot,
  Session,
  Window,
  WindowRole,
} from "./types";

// Backfill role for windows persisted before WindowRole existed. Inferred
// from name + structural cues so legacy snapshots open without state loss.
function deriveRole(w: Window): WindowRole {
  if (w.role) return w.role;
  if (w.name === "files") return "files";
  if (w.name === "git") return "git";
  if (w.name === "aws") return "aws";
  if (w.name === "rundeck") return "rundeck";
  if (w.name === "term" || /^\d+$/.test(w.name)) return "term";
  return "named";
}

// Boot/save round-trip. The wire format is described by PersistedSnapshot.
// Versioned — bump VERSION when the shape changes; older blobs are ignored
// and the user gets fresh defaults.

const VERSION = 4;
let lastSaved = "";

// Last persisted slice references. Zustand uses structural sharing — when
// nothing in a slice changed, the array/object identity is preserved — so
// reference equality is a sufficient "did this slice change?" check. We
// short-circuit the (expensive) JSON.stringify when every persisted slice
// is reference-equal to what we last sent to disk.
//
// `null` until the first save, which forces a stringify on boot.
type SliceShot = {
  sessions: StoreState["sessions"];
  windows: StoreState["windows"];
  agents: StoreState["agents"];
  sessionOrder: StoreState["sessionOrder"];
  windowsBySession: StoreState["windowsBySession"];
  agentsBySession: StoreState["agentsBySession"];
  activeSessionId: StoreState["activeSessionId"];
  recent: StoreState["recent"];
  agentBookmarks: StoreState["agentBookmarks"];
  editorViews: StoreState["editorViews"];
  projectRoots: StoreState["projectRoots"];
  themeId: StoreState["themeId"];
  windowOpacity: StoreState["windowOpacity"];
  windowBlur: StoreState["windowBlur"];
  cloudBrowser: StoreState["cloudBrowser"];
  cloudBrowserShortcut: StoreState["cloudBrowserShortcut"];
  awsProfile: StoreState["awsProfile"];
  awsService: StoreState["awsService"];
  leftRailOpen: StoreState["leftRailOpen"];
  rightRailOpen: StoreState["rightRailOpen"];
  rundeck: StoreState["rundeck"];
};
let lastSlices: SliceShot | null = null;

function takeSlices(s: StoreState): SliceShot {
  return {
    sessions: s.sessions,
    windows: s.windows,
    agents: s.agents,
    sessionOrder: s.sessionOrder,
    windowsBySession: s.windowsBySession,
    agentsBySession: s.agentsBySession,
    activeSessionId: s.activeSessionId,
    recent: s.recent,
    agentBookmarks: s.agentBookmarks,
    editorViews: s.editorViews,
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
    rundeck: s.rundeck,
  };
}

function slicesEqual(a: SliceShot, b: SliceShot): boolean {
  for (const k in a) {
    if ((a as Record<string, unknown>)[k] !== (b as Record<string, unknown>)[k]) {
      return false;
    }
  }
  return true;
}

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
      windows[w.id] = { ...w, role: deriveRole(w) };
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
    // Migrate older persisted shape — `{envs, activeEnv, prodEnvs}` is no
    // longer the wire shape. If we see it, fall through to defaults and
    // try to preserve activeProject via the legacy alias when present.
    rundeck: (() => {
      const raw = data.prefs?.rundeck as
        | {
            activeProject?: string;
            activeEnvFolder?: string | null;
            activeEnv?: string;
            prodEnvs?: string[];
          }
        | undefined;
      if (!raw) return cur.rundeck;
      const activeProject =
        raw.activeProject ??
        // Old `activeEnv` mapped via the historical alias table.
        (raw.activeEnv === "prod"
          ? "production"
          : raw.activeEnv === "preprod"
            ? "Preprod"
            : raw.activeEnv ?? cur.rundeck.activeProject);
      return {
        activeProject,
        activeEnvFolder: raw.activeEnvFolder ?? null,
        prodEnvs: raw.prodEnvs ?? cur.rundeck.prodEnvs,
      };
    })(),
  });
  // Snapshots from before the search pane existed lack a search window
  // for project sessions — add one in place so the user doesn't have to
  // close + reopen every project to get it.
  ensureSearchWindow();
  lastSaved = snapshot();
  lastSlices = takeSlices(getState());
}

/** Debounced save on every store change. Returns an unsubscribe function. */
export function subscribePersist(): () => void {
  let timer: number | undefined;
  return useStore.subscribe(() => {
    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      // Cheap ref-equality check across the persisted slices. View-only
      // state changing (modals, hover, focus) hits this path and exits
      // before we ever build the snapshot string.
      const slices = takeSlices(getState());
      if (lastSlices && slicesEqual(lastSlices, slices)) return;
      lastSlices = slices;

      const snap = snapshot();
      if (snap === lastSaved) return;
      lastSaved = snap;
      void invoke("state_save", { data: snap });
    }, 600);
  });
}

import type {
  Env,
  RecentEntry,
  Session,
  WinTab,
  WorkspaceSnapshot,
} from "../types";
import { makePane, newId } from "../layout";
import type { Slice } from "./types";

function makeWindow(
  cwd: string,
  name: string,
  opts?: { kind?: "terminal" | "editor" | "git"; startup?: string },
): WinTab {
  const pane = makePane(cwd, opts);
  return { id: newId("win"), name, root: pane, activePaneId: pane.id };
}

function projectWindows(cwd: string): WinTab[] {
  return [
    { ...makeWindow(cwd, "files", { kind: "editor" }), fixed: true },
    { ...makeWindow(cwd, "term"), fixed: true },
    { ...makeWindow(cwd, "git", { kind: "git" }), fixed: true },
  ];
}

function basename(path: string): string {
  const parts = path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || path;
}

function initialSession(): Session {
  const win = makeWindow("", "1");
  return {
    id: newId("sess"),
    name: "main",
    kind: "command",
    cwd: "",
    env: "dev",
    pinned: false,
    windows: [win],
    activeWindowId: win.id,
    agents: [],
    activeAgentId: null,
    view: "windows",
  };
}

export interface SessionsSlice {
  sessions: Record<string, Session>;
  sessionOrder: string[];
  activeSessionId: string;
  recent: RecentEntry[];

  // Internal CRUD — used by layout / agents slices too.
  patchSession: (id: string, fn: (s: Session) => Session) => void;
  patchActiveSession: (fn: (s: Session) => Session) => void;

  hydrate: (snap: WorkspaceSnapshot) => void;

  createProjectSession: (cwd: string) => void;
  selectSession: (id: string) => void;
  closeSession: (id: string) => void;
  closeActiveSession: () => void;
  cycleSession: (delta: number) => void;
  togglePin: (id: string) => void;
  reopenRecent: (entry: RecentEntry) => void;
  setEnv: (env: Env) => void;
}

export const createSessionsSlice: Slice<SessionsSlice> = (set, get) => {
  const first = initialSession();
  return {
    sessions: { [first.id]: first },
    sessionOrder: [first.id],
    activeSessionId: first.id,
    recent: [],

    patchSession: (id, fn) =>
      set((s) => {
        const cur = s.sessions[id];
        if (!cur) return {};
        return { sessions: { ...s.sessions, [id]: fn(cur) } };
      }),

    patchActiveSession: (fn) => get().patchSession(get().activeSessionId, fn),

    hydrate: (snap) =>
      set((st) => {
        if (!snap.sessions || snap.sessions.length === 0) return {};
        // Migrate any pre-rename windows: "run" → "term".
        const migrated = snap.sessions.map((s) => ({
          ...s,
          windows: s.windows.map((w) =>
            w.name === "run" ? { ...w, name: "term" } : w,
          ),
        }));
        const sessions: Record<string, Session> = {};
        const sessionOrder: string[] = [];
        for (const s of migrated) {
          sessions[s.id] = s;
          sessionOrder.push(s.id);
        }
        const activeSessionId = sessions[snap.activeSessionId]
          ? snap.activeSessionId
          : sessionOrder[0];
        return {
          sessions,
          sessionOrder,
          activeSessionId,
          recent: snap.recent ?? [],
          agentBookmarks: snap.agentBookmarks ?? [],
          leftRailOpen: snap.leftRailOpen ?? st.leftRailOpen,
          rightRailOpen: snap.rightRailOpen ?? st.rightRailOpen,
        };
      }),

    createProjectSession: (cwd) =>
      set((st) => {
        const existing = st.sessionOrder
          .map((id) => st.sessions[id])
          .find((s) => s.cwd === cwd && s.kind === "project");
        if (existing) {
          return { pickerOpen: false, activeSessionId: existing.id };
        }
        const windows = projectWindows(cwd);
        const session: Session = {
          id: newId("sess"),
          name: basename(cwd),
          kind: "project",
          cwd,
          env: "dev",
          pinned: false,
          windows,
          activeWindowId: windows[0].id,
          agents: [],
          activeAgentId: null,
          view: "windows",
        };
        return {
          pickerOpen: false,
          zoomedPaneId: null,
          sessions: { ...st.sessions, [session.id]: session },
          sessionOrder: [...st.sessionOrder, session.id],
          activeSessionId: session.id,
        };
      }),

    selectSession: (id) =>
      set((st) =>
        st.sessions[id]
          ? { activeSessionId: id, zoomedPaneId: null, pickerOpen: false }
          : {},
      ),

    closeSession: (id) =>
      set((st) => {
        if (st.sessionOrder.length <= 1) return {};
        const closed = st.sessions[id];
        if (!closed) return {};
        const idx = st.sessionOrder.indexOf(id);
        const sessionOrder = st.sessionOrder.filter((x) => x !== id);
        const sessions = { ...st.sessions };
        delete sessions[id];
        const activeSessionId =
          st.activeSessionId === id
            ? sessionOrder[Math.min(idx, sessionOrder.length - 1)]
            : st.activeSessionId;
        const recent: RecentEntry[] =
          closed.kind === "command"
            ? st.recent
            : [
                { kind: closed.kind, name: closed.name, cwd: closed.cwd },
                ...st.recent.filter((r) => r.cwd !== closed.cwd),
              ].slice(0, 12);
        return { zoomedPaneId: null, sessions, sessionOrder, activeSessionId, recent };
      }),

    closeActiveSession: () => get().closeSession(get().activeSessionId),

    cycleSession: (delta) =>
      set((st) => {
        const cur = st.sessions[st.activeSessionId];
        if (!cur) return {};
        const groupIds = st.sessionOrder.filter(
          (id) => st.sessions[id].kind === cur.kind,
        );
        if (groupIds.length < 2) return {};
        const idx = groupIds.indexOf(cur.id);
        const next =
          groupIds[(idx + delta + groupIds.length) % groupIds.length];
        return { activeSessionId: next, zoomedPaneId: null };
      }),

    togglePin: (id) =>
      get().patchSession(id, (s) => ({ ...s, pinned: !s.pinned })),

    reopenRecent: (entry) => {
      get().createProjectSession(entry.cwd);
      set((st) => ({ recent: st.recent.filter((r) => r.cwd !== entry.cwd) }));
    },

    setEnv: (env) => get().patchActiveSession((s) => ({ ...s, env })),
  };
};

export { makeWindow, projectWindows };

import { create } from "zustand";
import type {
  Agent,
  AgentType,
  Env,
  FocusDir,
  RecentEntry,
  Session,
  SplitDir,
  WinTab,
  WorkspaceSnapshot,
} from "./types";
import {
  collectPanes,
  computeLayout,
  makePane,
  neighborPane,
  newId,
  removePane,
  resizeTowards,
  setSplitSizes,
  splitPane,
} from "./layout";

function makeWindow(
  cwd: string,
  name: string,
  opts?: { kind?: "terminal" | "editor" | "git"; startup?: string },
): WinTab {
  const pane = makePane(cwd, opts);
  return { id: newId("win"), name, root: pane, activePaneId: pane.id };
}

// A project's window-set: files / run / git. All fixed — M-w can't destroy
// them. Agents are NOT windows; they live in the right rail.
function projectWindows(cwd: string): WinTab[] {
  return [
    { ...makeWindow(cwd, "files", { kind: "editor" }), fixed: true },
    { ...makeWindow(cwd, "run"), fixed: true },
    { ...makeWindow(cwd, "git", { kind: "git" }), fixed: true },
  ];
}

function agentStartup(type: AgentType, resumeId?: string): string {
  if (!resumeId) return type;
  if (type === "claude") return `claude --resume ${resumeId}`;
  if (type === "codex") return `codex resume ${resumeId}`;
  if (type === "hermes") return `hermes --resume ${resumeId}`;
  return type;
}

function makeAgent(type: AgentType, resumeId?: string, title?: string): Agent {
  return {
    id: newId("agent"),
    type,
    title: title ?? type,
    startup: agentStartup(type, resumeId),
  };
}

function basename(path: string): string {
  const parts = path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || path;
}

function initialSessions(): { sessions: Session[]; activeSessionId: string } {
  const win = makeWindow("", "1");
  const session: Session = {
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
  return { sessions: [session], activeSessionId: session.id };
}

interface WorkspaceStore {
  sessions: Session[];
  activeSessionId: string;
  recent: RecentEntry[];
  zoomedPaneId: string | null;
  pickerOpen: boolean;
  leftRailOpen: boolean;
  rightRailOpen: boolean;
  home: string;
  openRequest: { path: string; n: number } | null;
  agentFocusN: number;

  setHome: (home: string) => void;
  hydrate: (snap: WorkspaceSnapshot) => void;
  requestOpenFile: (path: string) => void;
  openPicker: () => void;
  closePicker: () => void;
  toggleLeftRail: () => void;
  toggleRightRail: () => void;

  splitActivePane: (dir: SplitDir) => void;
  closeActivePane: () => void;
  focusPane: (paneId: string) => void;
  moveFocus: (dir: FocusDir) => void;
  resizeActivePane: (dir: FocusDir) => void;
  toggleZoom: () => void;
  setSplitSizes: (windowId: string, splitId: string, sizes: number[]) => void;

  newWindow: () => void;
  closeActiveWindow: () => void;
  selectWindowId: (id: string) => void;
  selectWindowByIndex: (index: number) => void;
  selectWindowByName: (name: string) => void;
  selectWindowRelative: (delta: number) => void;

  addAgent: (type: AgentType, resumeId?: string, title?: string) => void;
  selectAgent: (id: string) => void;
  closeAgent: (id: string) => void;
  focusAgents: () => void;

  createProjectSession: (cwd: string) => void;
  selectSession: (id: string) => void;
  closeSession: (id: string) => void;
  closeActiveSession: () => void;
  cycleSession: (delta: number) => void;
  togglePin: (id: string) => void;
  reopenRecent: (entry: RecentEntry) => void;
  setEnv: (env: Env) => void;
}

export const useWorkspace = create<WorkspaceStore>((set, get) => {
  function activeSession(st: WorkspaceStore): Session {
    return st.sessions.find((s) => s.id === st.activeSessionId)!;
  }

  function patchSession(
    st: WorkspaceStore,
    id: string,
    fn: (s: Session) => Session,
  ): Session[] {
    return st.sessions.map((s) => (s.id === id ? fn(s) : s));
  }

  // Transform one window of the active session, switching the view to windows.
  function patchActiveWindow(
    st: WorkspaceStore,
    fn: (win: WinTab) => WinTab,
  ): Session[] {
    return st.sessions.map((s) => {
      if (s.id !== st.activeSessionId) return s;
      return {
        ...s,
        view: "windows",
        windows: s.windows.map((w) => (w.id === s.activeWindowId ? fn(w) : w)),
      };
    });
  }

  return {
    ...initialSessions(),
    recent: [],
    zoomedPaneId: null,
    pickerOpen: false,
    leftRailOpen: true,
    rightRailOpen: true,
    home: "",
    openRequest: null,
    agentFocusN: 0,

    setHome: (home) => set({ home }),

    hydrate: (snap) =>
      set((st) => {
        if (!snap.sessions || snap.sessions.length === 0) return {};
        const activeSessionId = snap.sessions.some(
          (s) => s.id === snap.activeSessionId,
        )
          ? snap.activeSessionId
          : snap.sessions[0].id;
        return {
          sessions: snap.sessions,
          activeSessionId,
          recent: snap.recent ?? [],
          leftRailOpen: snap.leftRailOpen ?? st.leftRailOpen,
          rightRailOpen: snap.rightRailOpen ?? st.rightRailOpen,
        };
      }),

    requestOpenFile: (path) =>
      set((st) => {
        const s = activeSession(st);
        const filesWin = s.windows.find((w) => w.name === "files");
        return {
          openRequest: { path, n: (st.openRequest?.n ?? 0) + 1 },
          zoomedPaneId: null,
          sessions: filesWin
            ? patchSession(st, s.id, (x) => ({
                ...x,
                activeWindowId: filesWin.id,
                view: "windows",
              }))
            : st.sessions,
        };
      }),

    openPicker: () => set({ pickerOpen: true }),
    closePicker: () => set({ pickerOpen: false }),
    toggleLeftRail: () => set((st) => ({ leftRailOpen: !st.leftRailOpen })),
    toggleRightRail: () => set((st) => ({ rightRailOpen: !st.rightRailOpen })),

    splitActivePane: (dir) =>
      set((st) => {
        const s = activeSession(st);
        const np = makePane(s.cwd);
        return {
          zoomedPaneId: null,
          sessions: patchActiveWindow(st, (w) => ({
            ...w,
            root: splitPane(w.root, w.activePaneId, dir, np),
            activePaneId: np.id,
          })),
        };
      }),

    closeActivePane: () =>
      set((st) => {
        const s = activeSession(st);
        const w = s.windows.find((x) => x.id === s.activeWindowId)!;
        const root = removePane(w.root, w.activePaneId);
        if (root === null && w.fixed) return {};
        if (root === null) {
          if (s.windows.length <= 1) {
            const fresh = makeWindow(s.cwd, w.name);
            return {
              zoomedPaneId: null,
              sessions: patchSession(st, s.id, (x) => ({
                ...x,
                windows: [fresh],
                activeWindowId: fresh.id,
              })),
            };
          }
          const idx = s.windows.findIndex((x) => x.id === w.id);
          const windows = s.windows.filter((x) => x.id !== w.id);
          const next = windows[Math.min(idx, windows.length - 1)];
          return {
            zoomedPaneId: null,
            sessions: patchSession(st, s.id, (x) => ({
              ...x,
              windows,
              activeWindowId: next.id,
            })),
          };
        }
        const remaining = collectPanes(root);
        return {
          zoomedPaneId: null,
          sessions: patchActiveWindow(st, (win) => ({
            ...win,
            root,
            activePaneId: remaining[0].id,
          })),
        };
      }),

    focusPane: (paneId) =>
      set((st) => ({
        sessions: patchActiveWindow(st, (w) => ({ ...w, activePaneId: paneId })),
      })),

    moveFocus: (dir) =>
      set((st) => {
        const s = activeSession(st);
        const w = s.windows.find((x) => x.id === s.activeWindowId)!;
        const { panes } = computeLayout(w.root);
        const next = neighborPane(panes, w.activePaneId, dir);
        if (!next) return {};
        return {
          sessions: patchActiveWindow(st, (win) => ({ ...win, activePaneId: next })),
        };
      }),

    resizeActivePane: (dir) =>
      set((st) => ({
        sessions: patchActiveWindow(st, (w) => ({
          ...w,
          root: resizeTowards(w.root, w.activePaneId, dir),
        })),
      })),

    toggleZoom: () =>
      set((st) => {
        if (st.zoomedPaneId) return { zoomedPaneId: null };
        const s = activeSession(st);
        if (s.view !== "windows") return {};
        const w = s.windows.find((x) => x.id === s.activeWindowId)!;
        return { zoomedPaneId: w.activePaneId };
      }),

    setSplitSizes: (windowId, splitId, sizes) =>
      set((st) => ({
        sessions: patchSession(st, st.activeSessionId, (s) => ({
          ...s,
          windows: s.windows.map((w) =>
            w.id !== windowId
              ? w
              : { ...w, root: setSplitSizes(w.root, splitId, sizes) },
          ),
        })),
      })),

    newWindow: () =>
      set((st) => {
        const s = activeSession(st);
        const w = makeWindow(s.cwd, String(s.windows.length + 1));
        return {
          zoomedPaneId: null,
          sessions: patchSession(st, s.id, (x) => ({
            ...x,
            windows: [...x.windows, w],
            activeWindowId: w.id,
            view: "windows",
          })),
        };
      }),

    closeActiveWindow: () =>
      set((st) => {
        const s = activeSession(st);
        if (s.windows.find((x) => x.id === s.activeWindowId)?.fixed) return {};
        if (s.windows.length <= 1) return {};
        const idx = s.windows.findIndex((x) => x.id === s.activeWindowId);
        const windows = s.windows.filter((x) => x.id !== s.activeWindowId);
        const next = windows[Math.min(idx, windows.length - 1)];
        return {
          zoomedPaneId: null,
          sessions: patchSession(st, s.id, (x) => ({
            ...x,
            windows,
            activeWindowId: next.id,
          })),
        };
      }),

    selectWindowId: (id) =>
      set((st) => ({
        zoomedPaneId: null,
        sessions: patchSession(st, st.activeSessionId, (s) =>
          s.windows.some((w) => w.id === id)
            ? { ...s, activeWindowId: id, view: "windows" }
            : s,
        ),
      })),

    selectWindowByIndex: (index) =>
      set((st) => {
        const s = activeSession(st);
        const w = s.windows[index];
        if (!w) return {};
        return {
          zoomedPaneId: null,
          sessions: patchSession(st, s.id, (x) => ({
            ...x,
            activeWindowId: w.id,
            view: "windows",
          })),
        };
      }),

    selectWindowByName: (name) =>
      set((st) => {
        const s = activeSession(st);
        const w = s.windows.find((x) => x.name === name);
        if (!w) return {};
        return {
          zoomedPaneId: null,
          sessions: patchSession(st, s.id, (x) => ({
            ...x,
            activeWindowId: w.id,
            view: "windows",
          })),
        };
      }),

    selectWindowRelative: (delta) =>
      set((st) => {
        const s = activeSession(st);
        const idx = s.windows.findIndex((w) => w.id === s.activeWindowId);
        const next =
          s.windows[(idx + delta + s.windows.length) % s.windows.length];
        return {
          zoomedPaneId: null,
          sessions: patchSession(st, s.id, (x) => ({
            ...x,
            activeWindowId: next.id,
            view: "windows",
          })),
        };
      }),

    addAgent: (type, resumeId, title) =>
      set((st) => {
        const s = activeSession(st);
        if (s.kind !== "project") return {};
        const agent = makeAgent(type, resumeId, title);
        return {
          zoomedPaneId: null,
          sessions: patchSession(st, s.id, (x) => ({
            ...x,
            agents: [...x.agents, agent],
            activeAgentId: agent.id,
            view: "agent",
          })),
        };
      }),

    selectAgent: (id) =>
      set((st) => ({
        zoomedPaneId: null,
        sessions: patchSession(st, st.activeSessionId, (s) => ({
          ...s,
          activeAgentId: id,
          view: "agent",
        })),
      })),

    closeAgent: (id) =>
      set((st) => {
        const s = activeSession(st);
        const agents = s.agents.filter((a) => a.id !== id);
        const wasActive = s.activeAgentId === id;
        return {
          sessions: patchSession(st, s.id, (x) => ({
            ...x,
            agents,
            activeAgentId: wasActive ? (agents[0]?.id ?? null) : x.activeAgentId,
            view: wasActive && agents.length === 0 ? "windows" : x.view,
          })),
        };
      }),

    focusAgents: () =>
      set((st) => {
        const s = activeSession(st);
        // Always bump the focus nonce (the rail focuses its search on it);
        // switch to the agent view only when there's an agent to show.
        if (s.agents.length === 0) {
          return { agentFocusN: st.agentFocusN + 1 };
        }
        return {
          agentFocusN: st.agentFocusN + 1,
          zoomedPaneId: null,
          sessions: patchSession(st, s.id, (x) => ({
            ...x,
            view: "agent",
            activeAgentId: x.activeAgentId ?? x.agents[0].id,
          })),
        };
      }),

    createProjectSession: (cwd) =>
      set((st) => {
        const existing = st.sessions.find(
          (s) => s.cwd === cwd && s.kind === "project",
        );
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
          sessions: [...st.sessions, session],
          activeSessionId: session.id,
        };
      }),

    selectSession: (id) =>
      set((st) =>
        st.sessions.some((s) => s.id === id)
          ? { activeSessionId: id, zoomedPaneId: null, pickerOpen: false }
          : {},
      ),

    closeSession: (id) =>
      set((st) => {
        if (st.sessions.length <= 1) return {};
        const closed = st.sessions.find((s) => s.id === id);
        if (!closed) return {};
        const idx = st.sessions.findIndex((s) => s.id === id);
        const sessions = st.sessions.filter((s) => s.id !== id);
        const activeSessionId =
          st.activeSessionId === id
            ? sessions[Math.min(idx, sessions.length - 1)].id
            : st.activeSessionId;
        const recent: RecentEntry[] =
          closed.kind === "command"
            ? st.recent
            : [
                { kind: closed.kind, name: closed.name, cwd: closed.cwd },
                ...st.recent.filter((r) => r.cwd !== closed.cwd),
              ].slice(0, 12);
        return { zoomedPaneId: null, sessions, activeSessionId, recent };
      }),

    closeActiveSession: () => get().closeSession(get().activeSessionId),

    cycleSession: (delta) =>
      set((st) => {
        const cur = activeSession(st);
        const group = st.sessions.filter((s) => s.kind === cur.kind);
        if (group.length < 2) return {};
        const idx = group.findIndex((s) => s.id === cur.id);
        const next = group[(idx + delta + group.length) % group.length];
        return { activeSessionId: next.id, zoomedPaneId: null };
      }),

    togglePin: (id) =>
      set((st) => ({
        sessions: st.sessions.map((s) =>
          s.id === id ? { ...s, pinned: !s.pinned } : s,
        ),
      })),

    reopenRecent: (entry) => {
      get().createProjectSession(entry.cwd);
      set((st) => ({ recent: st.recent.filter((r) => r.cwd !== entry.cwd) }));
    },

    setEnv: (env) =>
      set((st) => ({
        sessions: patchSession(st, st.activeSessionId, (s) => ({ ...s, env })),
      })),
  };
});

import { create } from "zustand";
import type {
  Env,
  FocusDir,
  Session,
  SplitDir,
  SplitNode,
  WinTab,
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

function makeWindow(cwd: string, name: string, startup?: string): WinTab {
  const pane = makePane(cwd, startup);
  return { id: newId("win"), name, root: pane, activePaneId: pane.id };
}

// The 4-window layout every project session gets: nvim / run / git / agent,
// mirroring the user's tmux-workspace-layout.
function projectWindows(cwd: string): WinTab[] {
  const agentPanes = [makePane(cwd), makePane(cwd), makePane(cwd)];
  const agentRoot: SplitNode = {
    type: "split",
    id: newId("split"),
    dir: "row",
    children: agentPanes,
    sizes: [1 / 3, 1 / 3, 1 / 3],
  };
  const nvim = makeWindow(cwd, "nvim", "nvim");
  const run = makeWindow(cwd, "run");
  const git = makeWindow(cwd, "git", "lazygit");
  return [
    nvim,
    run,
    git,
    { id: newId("win"), name: "agent", root: agentRoot, activePaneId: agentPanes[0].id },
  ];
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
    windows: [win],
    activeWindowId: win.id,
  };
  return { sessions: [session], activeSessionId: session.id };
}

interface WorkspaceStore {
  sessions: Session[];
  activeSessionId: string;
  zoomedPaneId: string | null;
  pickerOpen: boolean;
  leftRailOpen: boolean;
  rightRailOpen: boolean;
  home: string;

  setHome: (home: string) => void;
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

  createProjectSession: (cwd: string) => void;
  selectSession: (id: string) => void;
  closeActiveSession: () => void;
  cycleSession: (delta: number) => void;
  setEnv: (env: Env) => void;
}

export const useWorkspace = create<WorkspaceStore>((set) => {
  function patchActiveWindow(
    st: WorkspaceStore,
    fn: (win: WinTab) => WinTab,
  ): Session[] {
    return st.sessions.map((s) => {
      if (s.id !== st.activeSessionId) return s;
      return {
        ...s,
        windows: s.windows.map((w) => (w.id === s.activeWindowId ? fn(w) : w)),
      };
    });
  }

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

  return {
    ...initialSessions(),
    zoomedPaneId: null,
    pickerOpen: false,
    leftRailOpen: true,
    rightRailOpen: true,
    home: "",

    setHome: (home) => set({ home }),
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
          })),
        };
      }),

    closeActiveWindow: () =>
      set((st) => {
        const s = activeSession(st);
        if (s.windows.length <= 1) {
          const fresh = makeWindow(s.cwd, s.windows[0].name);
          return {
            zoomedPaneId: null,
            sessions: patchSession(st, s.id, (x) => ({
              ...x,
              windows: [fresh],
              activeWindowId: fresh.id,
            })),
          };
        }
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
          s.windows.some((w) => w.id === id) ? { ...s, activeWindowId: id } : s,
        ),
      })),

    selectWindowByIndex: (index) =>
      set((st) => {
        const s = activeSession(st);
        const w = s.windows[index];
        if (!w) return {};
        return {
          zoomedPaneId: null,
          sessions: patchSession(st, s.id, (x) => ({ ...x, activeWindowId: w.id })),
        };
      }),

    selectWindowByName: (name) =>
      set((st) => {
        const s = activeSession(st);
        const w = s.windows.find((x) => x.name === name);
        if (!w) return {};
        return {
          zoomedPaneId: null,
          sessions: patchSession(st, s.id, (x) => ({ ...x, activeWindowId: w.id })),
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
          })),
        };
      }),

    createProjectSession: (cwd) =>
      set((st) => {
        const existing = st.sessions.find((s) => s.cwd === cwd);
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
          windows,
          activeWindowId: windows[0].id,
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

    closeActiveSession: () =>
      set((st) => {
        if (st.sessions.length <= 1) return {};
        const idx = st.sessions.findIndex((s) => s.id === st.activeSessionId);
        const sessions = st.sessions.filter((s) => s.id !== st.activeSessionId);
        const next = sessions[Math.min(idx, sessions.length - 1)];
        return {
          zoomedPaneId: null,
          sessions,
          activeSessionId: next.id,
        };
      }),

    cycleSession: (delta) =>
      set((st) => {
        const cur = activeSession(st);
        const group = st.sessions.filter((s) => s.kind === cur.kind);
        if (group.length < 2) return {};
        const idx = group.findIndex((s) => s.id === cur.id);
        const next = group[(idx + delta + group.length) % group.length];
        return { activeSessionId: next.id, zoomedPaneId: null };
      }),

    setEnv: (env) =>
      set((st) => ({
        sessions: patchSession(st, st.activeSessionId, (s) => ({ ...s, env })),
      })),
  };
});

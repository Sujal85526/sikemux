import type {
  FocusDir,
  Session,
  SplitDir,
  WinTab,
} from "../types";
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
} from "../layout";
import { makeWindow } from "./sessions";
import type { Slice } from "./types";

// All layout ops apply to the ACTIVE session's ACTIVE window — splits, pane
// closes, focus moves, window/tab CRUD, zoom toggle.
export interface LayoutSlice {
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
}

function patchActiveWindow(s: Session, fn: (w: WinTab) => WinTab): Session {
  return {
    ...s,
    view: "windows",
    windows: s.windows.map((w) => (w.id === s.activeWindowId ? fn(w) : w)),
  };
}

export const createLayoutSlice: Slice<LayoutSlice> = (set, get) => ({
  splitActivePane: (dir) =>
    set((st) => {
      const s = st.sessions[st.activeSessionId];
      if (!s) return {};
      const np = makePane(s.cwd);
      const next = patchActiveWindow(s, (w) => ({
        ...w,
        root: splitPane(w.root, w.activePaneId, dir, np),
        activePaneId: np.id,
      }));
      return {
        zoomedPaneId: null,
        sessions: { ...st.sessions, [s.id]: next },
      };
    }),

  closeActivePane: () =>
    set((st) => {
      const s = st.sessions[st.activeSessionId];
      if (!s) return {};
      const w = s.windows.find((x) => x.id === s.activeWindowId)!;
      const root = removePane(w.root, w.activePaneId);
      if (root === null && w.fixed) return {};
      if (root === null) {
        if (s.windows.length <= 1) {
          const fresh = makeWindow(s.cwd, w.name);
          return {
            zoomedPaneId: null,
            sessions: {
              ...st.sessions,
              [s.id]: { ...s, windows: [fresh], activeWindowId: fresh.id },
            },
          };
        }
        const idx = s.windows.findIndex((x) => x.id === w.id);
        const windows = s.windows.filter((x) => x.id !== w.id);
        const next = windows[Math.min(idx, windows.length - 1)];
        return {
          zoomedPaneId: null,
          sessions: {
            ...st.sessions,
            [s.id]: { ...s, windows, activeWindowId: next.id },
          },
        };
      }
      const remaining = collectPanes(root);
      const updated = patchActiveWindow(s, (win) => ({
        ...win,
        root,
        activePaneId: remaining[0].id,
      }));
      return { zoomedPaneId: null, sessions: { ...st.sessions, [s.id]: updated } };
    }),

  focusPane: (paneId) =>
    get().patchActiveSession((s) =>
      patchActiveWindow(s, (w) => ({ ...w, activePaneId: paneId })),
    ),

  moveFocus: (dir) =>
    set((st) => {
      const s = st.sessions[st.activeSessionId];
      if (!s) return {};
      const w = s.windows.find((x) => x.id === s.activeWindowId)!;
      const { panes } = computeLayout(w.root);
      const next = neighborPane(panes, w.activePaneId, dir);
      if (!next) return {};
      const updated = patchActiveWindow(s, (win) => ({ ...win, activePaneId: next }));
      return { sessions: { ...st.sessions, [s.id]: updated } };
    }),

  resizeActivePane: (dir) =>
    get().patchActiveSession((s) =>
      patchActiveWindow(s, (w) => ({
        ...w,
        root: resizeTowards(w.root, w.activePaneId, dir),
      })),
    ),

  toggleZoom: () =>
    set((st) => {
      if (st.zoomedPaneId) return { zoomedPaneId: null };
      const s = st.sessions[st.activeSessionId];
      if (!s || s.view !== "windows") return {};
      const w = s.windows.find((x) => x.id === s.activeWindowId)!;
      return { zoomedPaneId: w.activePaneId };
    }),

  setSplitSizes: (windowId, splitId, sizes) =>
    get().patchActiveSession((s) => ({
      ...s,
      windows: s.windows.map((w) =>
        w.id !== windowId ? w : { ...w, root: setSplitSizesFn(w.root, splitId, sizes) },
      ),
    })),

  newWindow: () =>
    set((st) => {
      const s = st.sessions[st.activeSessionId];
      if (!s) return {};
      const w: WinTab = {
        id: newId("win"),
        name: String(s.windows.length + 1),
        root: makePane(s.cwd),
        activePaneId: "",
      };
      w.activePaneId = (w.root as { id: string }).id;
      return {
        zoomedPaneId: null,
        sessions: {
          ...st.sessions,
          [s.id]: {
            ...s,
            windows: [...s.windows, w],
            activeWindowId: w.id,
            view: "windows",
          },
        },
      };
    }),

  closeActiveWindow: () =>
    set((st) => {
      const s = st.sessions[st.activeSessionId];
      if (!s) return {};
      const closing = s.windows.find((x) => x.id === s.activeWindowId);
      if (closing?.fixed) return {};
      if (s.windows.length <= 1) return {};
      const idx = s.windows.findIndex((x) => x.id === s.activeWindowId);
      const windows = s.windows.filter((x) => x.id !== s.activeWindowId);
      // When the user closes a term tab (`term` or numeric-named) we want
      // focus to land on ANOTHER term tab, not the adjacent files/git
      // window. Otherwise their attention pops out of the terminal stack
      // entirely on a single keystroke. Fall back to the index-neighbour
      // rule only when no sibling term tab exists.
      const isTermTab = (name: string) =>
        name === "term" || /^\d+$/.test(name);
      let next = windows[Math.min(idx, windows.length - 1)];
      if (closing && isTermTab(closing.name)) {
        const sibling =
          windows.slice(0, idx).reverse().find((w) => isTermTab(w.name)) ??
          windows.slice(idx).find((w) => isTermTab(w.name));
        if (sibling) next = sibling;
      }
      return {
        zoomedPaneId: null,
        sessions: {
          ...st.sessions,
          [s.id]: { ...s, windows, activeWindowId: next.id },
        },
      };
    }),

  selectWindowId: (id) =>
    set((st) => {
      const s = st.sessions[st.activeSessionId];
      if (!s || !s.windows.some((w) => w.id === id)) return {};
      return {
        zoomedPaneId: null,
        sessions: {
          ...st.sessions,
          [s.id]: { ...s, activeWindowId: id, view: "windows" },
        },
      };
    }),

  selectWindowByIndex: (index) =>
    set((st) => {
      const s = st.sessions[st.activeSessionId];
      const w = s?.windows[index];
      if (!s || !w) return {};
      return {
        zoomedPaneId: null,
        sessions: {
          ...st.sessions,
          [s.id]: { ...s, activeWindowId: w.id, view: "windows" },
        },
      };
    }),

  selectWindowByName: (name) =>
    set((st) => {
      const s = st.sessions[st.activeSessionId];
      const w = s?.windows.find((x) => x.name === name);
      if (!s || !w) return {};
      return {
        zoomedPaneId: null,
        sessions: {
          ...st.sessions,
          [s.id]: { ...s, activeWindowId: w.id, view: "windows" },
        },
      };
    }),

  selectWindowRelative: (delta) =>
    set((st) => {
      const s = st.sessions[st.activeSessionId];
      if (!s) return {};
      const idx = s.windows.findIndex((w) => w.id === s.activeWindowId);
      const next = s.windows[(idx + delta + s.windows.length) % s.windows.length];
      return {
        zoomedPaneId: null,
        sessions: {
          ...st.sessions,
          [s.id]: { ...s, activeWindowId: next.id, view: "windows" },
        },
      };
    }),
});

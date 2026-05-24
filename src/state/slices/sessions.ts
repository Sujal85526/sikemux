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
  createSshSession: (alias: string) => void;
  /** Spawn a fresh command (scratch) session — used by Alt+N in a command. */
  createCommandSession: () => void;
  /** Open (or focus) the singleton AWS session — one window holding an
   *  `aws`-kind pane. Profile + active service are tracked in the AWS slice. */
  openAwsSession: () => void;
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
          // Settings live in the same blob — apply them in hydrate so the
          // store and the visual world (CSS vars, CM theme, xterm theme)
          // come up in sync on launch.
          projectRoots:
            snap.settings?.projectRoots ?? st.projectRoots,
          themeId: snap.settings?.themeId ?? st.themeId,
          windowOpacity:
            snap.settings?.windowOpacity ?? st.windowOpacity,
          windowBlur:
            snap.settings?.windowBlur ?? st.windowBlur,
          cloudBrowser:
            snap.settings?.cloudBrowser ?? st.cloudBrowser,
          cloudBrowserShortcut:
            snap.settings?.cloudBrowserShortcut ?? st.cloudBrowserShortcut,
          awsProfile:
            snap.settings?.awsProfile ?? st.awsProfile,
          awsService:
            (() => {
              const persisted = snap.settings?.awsService;
              const valid = [
                "ecs",
                "ec2",
                "lambda",
                "sqs",
                "billing",
                "s3",
              ] as const;
              type V = (typeof valid)[number];
              return (valid as readonly string[]).includes(persisted ?? "")
                ? (persisted as V)
                : st.awsService;
            })(),
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

    createCommandSession: () =>
      set((st) => {
        // Number new command sessions sequentially based on the highest
        // numeric name already in the command group — keeps the sidebar
        // tidy as the user spawns more scratch terminals.
        const used = new Set<number>();
        for (const id of st.sessionOrder) {
          const s = st.sessions[id];
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
          windows: [win],
          activeWindowId: win.id,
          agents: [],
          activeAgentId: null,
          view: "windows",
        };
        return {
          zoomedPaneId: null,
          sessions: { ...st.sessions, [session.id]: session },
          sessionOrder: [...st.sessionOrder, session.id],
          activeSessionId: session.id,
        };
      }),

    openAwsSession: () =>
      set((st) => {
        const existing = st.sessionOrder
          .map((id) => st.sessions[id])
          .find((s) => s.kind === "aws");
        if (existing) {
          return { activeSessionId: existing.id, zoomedPaneId: null };
        }
        // Single window with one `aws`-kind pane. The pane's left sidebar
        // picks the active sub-service; profile lives in the AWS slice.
        const pane = makePane("", { kind: "aws" });
        const win: WinTab = {
          id: newId("win"),
          name: "aws",
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
          windows: [win],
          activeWindowId: win.id,
          agents: [],
          activeAgentId: null,
          view: "windows",
        };
        return {
          zoomedPaneId: null,
          sessions: { ...st.sessions, [session.id]: session },
          sessionOrder: [...st.sessionOrder, session.id],
          activeSessionId: session.id,
        };
      }),

    createSshSession: (alias) =>
      set((st) => {
        // Re-use an existing SSH session for the same alias instead of
        // stacking duplicates — picking the same host twice should just
        // focus the running terminal.
        const existing = st.sessionOrder
          .map((id) => st.sessions[id])
          .find((s) => s.kind === "ssh" && s.name === alias);
        if (existing) {
          return {
            sshPickerOpen: false,
            activeSessionId: existing.id,
            zoomedPaneId: null,
          };
        }
        // One terminal window, auto-runs `ssh <alias>` on PTY spawn.
        // Local shell stays underneath — `exit` returns to your shell so
        // reconnects are one keystroke (↑ Enter) away.
        const win = makeWindow("", alias, { startup: `ssh ${alias}` });
        const session: Session = {
          id: newId("sess"),
          name: alias,
          kind: "ssh",
          cwd: "",
          env: "dev",
          pinned: false,
          windows: [win],
          activeWindowId: win.id,
          agents: [],
          activeAgentId: null,
          view: "windows",
        };
        return {
          sshPickerOpen: false,
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

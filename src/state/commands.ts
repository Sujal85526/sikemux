import { invoke } from "@tauri-apps/api/core";
import { awsApi } from "../api/aws";
import { rundeckApi } from "../api/rundeck";
import { applyTheme, applyWindowOpacity } from "../themes/bus";
import { emit } from "./bus";
import { fetchResource, invalidate } from "./resources";
import { awsIdentityR } from "./resources.defs";
import { getState, setState, type StoreState } from "./store";
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

const patchSession = (id: string, fn: (s: Session) => Session): void =>
  setState((st) =>
    st.sessions[id]
      ? { sessions: { ...st.sessions, [id]: fn(st.sessions[id]) } }
      : {},
  );

const patchWindow = (id: string, fn: (w: Window) => Window): void =>
  setState((st) =>
    st.windows[id] ? { windows: { ...st.windows, [id]: fn(st.windows[id]) } } : {},
  );

// Most mutations want "with the active session, if there is one, do X" or
// "with the active window, if there is one, do X". Without these helpers
// every command repeats a 3-line guard. `fn` may return a partial state
// patch, or nothing for the no-op case.
type Patch = Partial<StoreState> | void;

const withActiveSession = (
  fn: (st: StoreState, session: Session) => Patch,
): void =>
  setState((st) => {
    const session = st.sessions[st.activeSessionId];
    if (!session) return {};
    return fn(st, session) ?? {};
  });

const withActiveWindow = (
  fn: (st: StoreState, win: Window, session: Session) => Patch,
): void =>
  setState((st) => {
    const session = st.sessions[st.activeSessionId];
    if (!session) return {};
    const win = st.windows[session.activeWindowId];
    if (!win) return {};
    return fn(st, win, session) ?? {};
  });

const basename = (p: string): string =>
  p.replace(/\/+$/, "").split("/").pop() || p;

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
  setState((st) => {
    const winPatch: Record<string, Window> = {};
    const owners: Record<string, string[]> = {};
    let changed = false;
    for (const sid of st.sessionOrder) {
      const sess = st.sessions[sid];
      if (sess.kind !== "project") continue;
      const winIds = st.windowsBySession[sid] ?? [];
      const hasSearch = winIds.some(
        (id) => st.windows[id]?.role === "search",
      );
      if (hasSearch) continue;
      const w = makeWindow(sess.cwd, "search", {
        kind: "search",
        fixed: true,
        role: "search",
      });
      winPatch[w.id] = w;
      owners[sid] = [...winIds, w.id];
      changed = true;
    }
    if (!changed) return {};
    return {
      windows: { ...st.windows, ...winPatch },
      windowsBySession: { ...st.windowsBySession, ...owners },
    };
  });
}

function attachSession(
  st: StoreState,
  session: Session,
  windows: Window[],
  agents: Agent[] = [],
): Partial<StoreState> {
  const winMap = { ...st.windows };
  const agentMap = { ...st.agents };
  for (const w of windows) winMap[w.id] = w;
  for (const a of agents) agentMap[a.id] = a;
  return {
    sessions: { ...st.sessions, [session.id]: session },
    sessionOrder: [...st.sessionOrder, session.id],
    windows: winMap,
    agents: agentMap,
    windowsBySession: {
      ...st.windowsBySession,
      [session.id]: windows.map((w) => w.id),
    },
    agentsBySession: {
      ...st.agentsBySession,
      [session.id]: agents.map((a) => a.id),
    },
    activeSessionId: session.id,
    zoomedPaneId: null,
    pickerOpen: false,
  };
}

// ---- Sessions ---------------------------------------------------------

export function createProjectSession(cwd: string): void {
  setState((st) => {
    const existing = st.sessionOrder
      .map((id) => st.sessions[id])
      .find((s) => s.cwd === cwd && s.kind === "project");
    if (existing) {
      return {
        pickerOpen: false,
        zoomedPaneId: null,
        activeSessionId: existing.id,
      };
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
    return attachSession(st, session, windows);
  });
}

export function createCommandSession(): void {
  setState((st) => {
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
      activeWindowId: win.id,
      activeAgentId: null,
      view: "windows",
    };
    return attachSession(st, session, [win]);
  });
}

export function createSshSession(alias: string): void {
  setState((st) => {
    const existing = st.sessionOrder
      .map((id) => st.sessions[id])
      .find((s) => s.kind === "ssh" && s.name === alias);
    if (existing) {
      return {
        pickerOpen: false,
        zoomedPaneId: null,
        activeSessionId: existing.id,
      };
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
    return attachSession(st, session, [win]);
  });
}

export function openAwsSession(): void {
  setState((st) => {
    const existing = st.sessionOrder
      .map((id) => st.sessions[id])
      .find((s) => s.kind === "aws");
    if (existing) {
      return { activeSessionId: existing.id, zoomedPaneId: null };
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
    return attachSession(st, session, [win]);
  });
}

export function openRundeckSession(): void {
  setState((st) => {
    const existing = st.sessionOrder
      .map((id) => st.sessions[id])
      .find((s) => s.kind === "rundeck");
    if (existing) {
      return { activeSessionId: existing.id, zoomedPaneId: null };
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
    return attachSession(st, session, [win]);
  });
}

// ---- Rundeck per-pane navigation -----------------------------------------

const rundeckView = (
  st: StoreState,
  paneId: string,
): RundeckView => st.rundeckViews[paneId] ?? { stack: [{ kind: "matrix" }] };

export function rundeckPush(paneId: string, level: RundeckLevel): void {
  setState((st) => {
    const cur = rundeckView(st, paneId);
    const next: RundeckView = { stack: [...cur.stack, level] };
    return {
      rundeckViews: { ...st.rundeckViews, [paneId]: next },
    };
  });
}

export function rundeckReplace(paneId: string, level: RundeckLevel): void {
  setState((st) => {
    const cur = rundeckView(st, paneId);
    const stack = cur.stack.slice(0, -1);
    stack.push(level);
    return {
      rundeckViews: { ...st.rundeckViews, [paneId]: { stack } },
    };
  });
}

export function rundeckPop(paneId: string): void {
  setState((st) => {
    const cur = rundeckView(st, paneId);
    if (cur.stack.length <= 1) return {};
    const stack = cur.stack.slice(0, -1);
    return { rundeckViews: { ...st.rundeckViews, [paneId]: { stack } } };
  });
}

export function rundeckHome(paneId: string): void {
  setState((st) => ({
    rundeckViews: {
      ...st.rundeckViews,
      [paneId]: { stack: [{ kind: "matrix" }] },
    },
  }));
}

/** Pane-level env selector (Rundeck pane only; project sessions use the
 *  session.env field instead). */
export function setRundeckEnv(envLabel: string): void {
  setState((st) => ({
    rundeck: { ...st.rundeck, activeEnv: envLabel },
  }));
}

/** From a project session: jump to the Rundeck service detail (execution
 *  history) for (basename(cwd), session.env). User picks the action from
 *  there — deploy / redeploy / open last — instead of being railroaded
 *  straight into a deploy confirm view they didn't ask for. */
export async function openRundeckServiceFor(
  service: string,
  envLabel: string,
): Promise<void> {
  const st = getState();
  const envSpec = st.rundeck.envs.find((e) => e.label === envLabel);
  if (!envSpec) return;
  openRundeckSession();
  const after = getState();
  const sess = Object.values(after.sessions).find((s) => s.kind === "rundeck");
  if (!sess) return;
  const win = after.windows[sess.activeWindowId];
  if (!win || win.root.type !== "pane") return;
  const paneId = win.root.id;
  // Sync the pane's env so the back-to-matrix breadcrumb shows the same env
  // the user came from.
  setRundeckEnv(envLabel);
  try {
    const job = await rundeckApi.resolveJob(envSpec.project, service);
    rundeckReplaceStack(paneId, [
      { kind: "matrix" },
      {
        kind: "service",
        env: envLabel,
        project: envSpec.project,
        service,
        jobId: job.id,
      },
    ]);
  } catch {
    // Service doesn't exist in this env's project — drop them at the matrix.
    rundeckReplaceStack(paneId, [{ kind: "matrix" }]);
  }
}

function rundeckReplaceStack(paneId: string, stack: RundeckLevel[]): void {
  setState((st) => ({
    rundeckViews: { ...st.rundeckViews, [paneId]: { stack } },
  }));
}

export function selectSession(id: string): void {
  setState((st) =>
    st.sessions[id]
      ? { activeSessionId: id, zoomedPaneId: null, pickerOpen: false }
      : {},
  );
}

export function closeSession(id: string): void {
  setState((st) => {
    if (st.sessionOrder.length <= 1) return {};
    const closed = st.sessions[id];
    if (!closed) return {};
    const idx = st.sessionOrder.indexOf(id);
    const sessionOrder = st.sessionOrder.filter((x) => x !== id);
    const sessions = { ...st.sessions };
    delete sessions[id];

    // Drop windows + agents that belonged to this session.
    const winIds = st.windowsBySession[id] ?? [];
    const agentIds = st.agentsBySession[id] ?? [];
    const windows = { ...st.windows };
    const agents = { ...st.agents };
    const editorViews = { ...st.editorViews };
    const gitViews = { ...st.gitViews };
    const ecsViews = { ...st.ecsViews };
    for (const wid of winIds) {
      const w = st.windows[wid];
      if (w) {
        for (const p of collectPanes(w.root)) {
          delete editorViews[p.id];
          delete gitViews[p.id];
          delete ecsViews[p.id];
        }
      }
      delete windows[wid];
    }
    for (const aid of agentIds) delete agents[aid];
    const windowsBySession = { ...st.windowsBySession };
    const agentsBySession = { ...st.agentsBySession };
    delete windowsBySession[id];
    delete agentsBySession[id];

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

    return {
      zoomedPaneId: null,
      sessions,
      sessionOrder,
      windows,
      agents,
      windowsBySession,
      agentsBySession,
      activeSessionId,
      recent,
      editorViews,
      gitViews,
      ecsViews,
    };
  });
}

export function closeActiveSession(): void {
  closeSession(getState().activeSessionId);
}

export function cycleSession(delta: number): void {
  setState((st) => {
    const cur = st.sessions[st.activeSessionId];
    if (!cur) return {};
    const groupIds = st.sessionOrder.filter(
      (id) => st.sessions[id].kind === cur.kind,
    );
    if (groupIds.length < 2) return {};
    const idx = groupIds.indexOf(cur.id);
    const next = groupIds[(idx + delta + groupIds.length) % groupIds.length];
    return { activeSessionId: next, zoomedPaneId: null };
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
  setState((st) => {
    const cur = st.sessions[st.activeSessionId];
    if (!cur) return {};
    // Find non-empty groups in the canonical order, preserving the
    // SessionKind sequence the user sees on the rail.
    const populated = GROUP_ORDER.filter((kind) =>
      st.sessionOrder.some((id) => st.sessions[id]?.kind === kind),
    );
    if (populated.length < 2) return {};
    const curIdx = populated.indexOf(cur.kind);
    if (curIdx === -1) return {};
    const nextKind =
      populated[(curIdx + delta + populated.length) % populated.length];
    const nextId = st.sessionOrder.find(
      (id) => st.sessions[id]?.kind === nextKind,
    );
    if (!nextId) return {};
    return { activeSessionId: nextId, zoomedPaneId: null };
  });
}

export function togglePin(id: string): void {
  patchSession(id, (s) => ({ ...s, pinned: !s.pinned }));
}

export function reopenRecent(entry: RecentEntry): void {
  createProjectSession(entry.cwd);
  setState((st) => ({ recent: st.recent.filter((r) => r.cwd !== entry.cwd) }));
}

export function setEnv(env: Env): void {
  patchSession(getState().activeSessionId, (s) => ({ ...s, env }));
}

// ---- Layout / panes ---------------------------------------------------

export function splitActivePane(dir: SplitDir): void {
  withActiveWindow((st, w, session) => {
    const np = makePane(session.cwd);
    return {
      zoomedPaneId: null,
      windows: {
        ...st.windows,
        [w.id]: {
          ...w,
          root: splitPane(w.root, w.activePaneId, dir, np),
          activePaneId: np.id,
        },
      },
    };
  });
}

export function closeActivePane(): void {
  withActiveWindow((st, w, session) => {
    const root = removePane(w.root, w.activePaneId);
    if (root === null && w.fixed) return {};
    if (root === null) {
      const winIds = st.windowsBySession[session.id] ?? [];
      if (winIds.length <= 1) {
        // Last window — reset to a fresh terminal in place.
        const fresh = makeWindow(session.cwd, w.name);
        const windows = { ...st.windows };
        delete windows[w.id];
        windows[fresh.id] = fresh;
        return {
          zoomedPaneId: null,
          windows,
          windowsBySession: {
            ...st.windowsBySession,
            [session.id]: [fresh.id],
          },
          sessions: {
            ...st.sessions,
            [session.id]: { ...session, activeWindowId: fresh.id },
          },
        };
      }
      const idx = winIds.indexOf(w.id);
      const remaining = winIds.filter((id) => id !== w.id);
      const nextId = remaining[Math.min(idx, remaining.length - 1)];
      const windows = { ...st.windows };
      delete windows[w.id];
      return {
        zoomedPaneId: null,
        windows,
        windowsBySession: { ...st.windowsBySession, [session.id]: remaining },
        sessions: {
          ...st.sessions,
          [session.id]: { ...session, activeWindowId: nextId },
        },
      };
    }
    const remaining = collectPanes(root);
    return {
      zoomedPaneId: null,
      windows: {
        ...st.windows,
        [w.id]: { ...w, root, activePaneId: remaining[0].id },
      },
    };
  });
}

export function focusPane(paneId: string): void {
  withActiveWindow((st, w) => ({
    windows: { ...st.windows, [w.id]: { ...w, activePaneId: paneId } },
  }));
}

export function moveFocus(dir: FocusDir): void {
  withActiveWindow((st, w) => {
    const { panes } = computeLayout(w.root);
    const next = neighborPane(panes, w.activePaneId, dir);
    if (!next) return;
    return {
      windows: { ...st.windows, [w.id]: { ...w, activePaneId: next } },
    };
  });
}

export function resizeActivePane(dir: FocusDir): void {
  withActiveWindow((st, w) => ({
    windows: {
      ...st.windows,
      [w.id]: { ...w, root: resizeTowards(w.root, w.activePaneId, dir) },
    },
  }));
}

export function toggleZoom(): void {
  withActiveSession((st, session) => {
    if (st.zoomedPaneId) return { zoomedPaneId: null };
    if (session.view !== "windows") return;
    const w = st.windows[session.activeWindowId];
    return w ? { zoomedPaneId: w.activePaneId } : undefined;
  });
}

export function setSplitSizes(
  windowId: string,
  splitId: string,
  sizes: number[],
): void {
  patchWindow(windowId, (w) => ({
    ...w,
    root: setSplitSizesFn(w.root, splitId, sizes),
  }));
}

// ---- Windows / tabs ---------------------------------------------------

export function newWindow(): void {
  withActiveSession((st, session) => {
    const winIds = st.windowsBySession[session.id] ?? [];
    const w = makeWindow(session.cwd, String(winIds.length + 1));
    return {
      zoomedPaneId: null,
      windows: { ...st.windows, [w.id]: w },
      windowsBySession: {
        ...st.windowsBySession,
        [session.id]: [...winIds, w.id],
      },
      sessions: {
        ...st.sessions,
        [session.id]: { ...session, activeWindowId: w.id, view: "windows" },
      },
    };
  });
}

export function closeActiveWindow(): void {
  withActiveSession((st, session) => {
    const closing = st.windows[session.activeWindowId];
    if (!closing || closing.fixed) return;
    const winIds = st.windowsBySession[session.id] ?? [];
    if (winIds.length <= 1) return;
    const idx = winIds.indexOf(closing.id);
    const remaining = winIds.filter((id) => id !== closing.id);
    // When closing a term tab, prefer to land on another term tab so the
    // user's attention stays inside the terminal stack.
    let nextId = remaining[Math.min(idx, remaining.length - 1)];
    if (closing.role === "term") {
      const isTerm = (id: string) => st.windows[id]?.role === "term";
      const before = remaining.slice(0, idx).reverse().find(isTerm);
      const after = remaining.slice(idx).find(isTerm);
      nextId = before ?? after ?? nextId;
    }
    const windows = { ...st.windows };
    delete windows[closing.id];
    // Prune pane views that lived in the closing window.
    const editorViews = { ...st.editorViews };
    const gitViews = { ...st.gitViews };
    const ecsViews = { ...st.ecsViews };
    for (const p of collectPanes(closing.root)) {
      delete editorViews[p.id];
      delete gitViews[p.id];
      delete ecsViews[p.id];
    }
    return {
      zoomedPaneId: null,
      windows,
      windowsBySession: { ...st.windowsBySession, [session.id]: remaining },
      sessions: {
        ...st.sessions,
        [session.id]: { ...session, activeWindowId: nextId },
      },
      editorViews,
      gitViews,
      ecsViews,
    };
  });
}

export function selectWindowId(id: string): void {
  withActiveSession((st, session) => {
    const winIds = st.windowsBySession[session.id] ?? [];
    if (!winIds.includes(id)) return;
    return {
      zoomedPaneId: null,
      sessions: {
        ...st.sessions,
        [session.id]: { ...session, activeWindowId: id, view: "windows" },
      },
    };
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

export function selectWindowRelative(delta: number): void {
  const st = getState();
  const session = st.sessions[st.activeSessionId];
  if (!session) return;
  const ids = st.windowsBySession[session.id] ?? [];
  if (ids.length < 2) return;
  const idx = ids.indexOf(session.activeWindowId);
  const next = ids[(idx + delta + ids.length) % ids.length];
  selectWindowId(next);
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

function agentStartup(
  type: AgentType,
  resumeId?: string,
  skipPermissions = false,
): string {
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
  setState((st) => {
    const a = st.agents[id];
    if (!a) return {};
    const next = !a.skipPermissions;
    return {
      agents: {
        ...st.agents,
        [id]: {
          ...a,
          skipPermissions: next,
          startup: agentStartup(a.type, a.resumeId, next),
        },
      },
    };
  });
}

export function addAgent(
  type: AgentType,
  resumeId?: string,
  title?: string,
): void {
  withActiveSession((st, session) => {
    if (session.kind !== "project") return;
    const ownedIds = st.agentsBySession[session.id] ?? [];
    const existing = resumeId
      ? ownedIds
          .map((id) => st.agents[id])
          .find((a) => a && a.type === type && a.resumeId === resumeId)
      : undefined;
    if (existing) {
      return {
        zoomedPaneId: null,
        sessions: {
          ...st.sessions,
          [session.id]: { ...session, activeAgentId: existing.id, view: "agent" },
        },
      };
    }
    const agent: Agent = {
      id: newId("agent"),
      type,
      title: title ?? type,
      startup: agentStartup(type, resumeId),
      resumeId,
    };
    return {
      zoomedPaneId: null,
      agents: { ...st.agents, [agent.id]: agent },
      agentsBySession: {
        ...st.agentsBySession,
        [session.id]: [...ownedIds, agent.id],
      },
      sessions: {
        ...st.sessions,
        [session.id]: { ...session, activeAgentId: agent.id, view: "agent" },
      },
    };
  });
}

export function selectAgent(id: string): void {
  withActiveSession((st, session) => ({
    sessions: {
      ...st.sessions,
      [session.id]: { ...session, activeAgentId: id, view: "agent" },
    },
  }));
}

export function closeAgent(id: string): void {
  setState((st) => {
    const ownerId = st.sessionOrder.find((sid) =>
      (st.agentsBySession[sid] ?? []).includes(id),
    );
    if (!ownerId) return {};
    const owner = st.sessions[ownerId];
    const ownedIds = (st.agentsBySession[ownerId] ?? []).filter(
      (aid) => aid !== id,
    );
    const wasActive = owner.activeAgentId === id;
    const agents = { ...st.agents };
    delete agents[id];
    return {
      agents,
      agentsBySession: { ...st.agentsBySession, [ownerId]: ownedIds },
      sessions: {
        ...st.sessions,
        [ownerId]: {
          ...owner,
          activeAgentId: wasActive ? (ownedIds[0] ?? null) : owner.activeAgentId,
          view: wasActive && ownedIds.length === 0 ? "windows" : owner.view,
        },
      },
    };
  });
}

export function focusAgents(): void {
  withActiveSession((st, session) => {
    const ids = st.agentsBySession[session.id] ?? [];
    return {
      zoomedPaneId: null,
      sessions: {
        ...st.sessions,
        [session.id]: {
          ...session,
          view: "agent",
          activeAgentId: session.activeAgentId ?? (ids[0] ?? null),
        },
      },
    };
  });
  emit({ type: "agent-focus", sessionId: getState().activeSessionId });
}

export function toggleAgentBookmark(b: AgentBookmark): void {
  setState((st) => {
    const has = st.agentBookmarks.some(
      (x) => x.type === b.type && x.id === b.id,
    );
    return {
      agentBookmarks: has
        ? st.agentBookmarks.filter((x) => !(x.type === b.type && x.id === b.id))
        : [b, ...st.agentBookmarks],
    };
  });
}

export function openAgentBookmark(b: AgentBookmark): void {
  const st = getState();
  // 1. Already running? Jump to its owner.
  for (const id of st.sessionOrder) {
    const sess = st.sessions[id];
    if (sess.kind !== "project") continue;
    const ownedIds = st.agentsBySession[id] ?? [];
    const live = ownedIds
      .map((aid) => st.agents[aid])
      .find((a) => a && a.type === b.type && a.resumeId === b.id);
    if (live) {
      setState((cur) => ({
        activeSessionId: id,
        zoomedPaneId: null,
        sessions: {
          ...cur.sessions,
          [id]: { ...cur.sessions[id], activeAgentId: live.id, view: "agent" },
        },
      }));
      return;
    }
  }

  // 2. Switch to bookmark's project (existing or new).
  if (b.cwd) {
    const cur = getState();
    const existing = cur.sessionOrder
      .map((id) => cur.sessions[id])
      .find((s) => s.kind === "project" && s.cwd === b.cwd);
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
      const freshs = ownedIds
        .map((aid) => cur.agents[aid])
        .filter((a) => a && a.type === b.type && !a.resumeId);
      if (freshs.length === 1) {
        const fresh = freshs[0]!;
        setState((c2) => ({
          agents: {
            ...c2.agents,
            [fresh.id]: { ...fresh, resumeId: b.id, title: b.title },
          },
          sessions: {
            ...c2.sessions,
            [dest.id]: {
              ...c2.sessions[dest.id],
              activeAgentId: fresh.id,
              view: "agent",
            },
          },
        }));
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
export const openPicker = (mode: PickerMode = "all"): void =>
  setState({ pickerOpen: true, pickerMode: mode });
export const closePicker = (): void => setState({ pickerOpen: false });
export const openAgentPalette = (): void => setState({ agentPaletteOpen: true });
export const closeAgentPalette = (): void =>
  setState({ agentPaletteOpen: false });
export const openFilePalette = (): void => setState({ filePaletteOpen: true });
export const closeFilePalette = (): void => setState({ filePaletteOpen: false });
export const openSettings = (): void => setState({ settingsOpen: true });
export const closeSettings = (): void => setState({ settingsOpen: false });
export const toggleSettings = (): void =>
  setState((s) => ({ settingsOpen: !s.settingsOpen }));
export const toggleLeftRail = (): void =>
  setState((s) => ({ leftRailOpen: !s.leftRailOpen }));
export const toggleRightRail = (): void =>
  setState((s) => ({ rightRailOpen: !s.rightRailOpen }));
export const openLspResults = (
  title: string,
  project: string,
  results: { uri: string; line: number; character: number }[],
): void => setState({ lspResults: { title, project, results } });
export const closeLspResults = (): void => setState({ lspResults: null });

// "Open file X" — emits an event. App.tsx subscribes and routes to the
// right session's editor pane; the EditorPane in that pane subscribes
// directly to apply the open + scroll.
export function requestOpenFile(
  path: string,
  line?: number,
  character?: number,
): void {
  // Navigate the active session to its files window if needed, so the
  // editor pane is mounted before the event fires.
  withActiveSession((st, session) => {
    const winIds = st.windowsBySession[session.id] ?? [];
    const filesId = winIds.find((id) => st.windows[id]?.role === "files");
    if (!filesId) return;
    if (session.activeWindowId === filesId && session.view === "windows") {
      return { zoomedPaneId: null };
    }
    return {
      zoomedPaneId: null,
      sessions: {
        ...st.sessions,
        [session.id]: {
          ...session,
          activeWindowId: filesId,
          view: "windows",
        },
      },
    };
  });
  emit({ type: "open-file", path, line, character });
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
  void invoke("set_window_blur", { radius: value }).catch(() => {});
  setState({ windowBlur: value });
}

export const setCloudBrowser = (v: string): void =>
  setState({ cloudBrowser: v.trim() });
export const setCloudBrowserShortcut = (v: string): void =>
  setState({ cloudBrowserShortcut: v.trim() });

export function addProjectRoot(path: string, depth = 1): void {
  setState((s) =>
    s.projectRoots.some((r) => r.path === path)
      ? {}
      : { projectRoots: [...s.projectRoots, { path, depth }] },
  );
}

export function removeProjectRoot(path: string): void {
  setState((s) => ({
    projectRoots: s.projectRoots.filter((r) => r.path !== path),
  }));
}

export function setProjectRootDepth(path: string, depth: number): void {
  const d = Math.max(0, Math.round(Number.isFinite(depth) ? depth : 1));
  setState((s) => ({
    projectRoots: s.projectRoots.map((r) =>
      r.path === path ? { ...r, depth: d } : r,
    ),
  }));
}

// Persist may hand us a legacy array of plain strings — normalise to the
// new shape with the default depth.
export function normaliseProjectRoots(
  raw: unknown,
): ProjectRoot[] {
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

export const setAwsProfile = (name: string | null): void =>
  setState({ awsProfile: name });
export const setAwsService = (s: AwsService): void => setState({ awsService: s });
export const openAwsAuthModal = (
  profile: string,
  ssoStartUrl: string | null,
): void => setState({ awsAuthModal: { profile, ssoStartUrl } });
export const closeAwsAuthModal = (): void => setState({ awsAuthModal: null });

export async function runAwsSsoLogin(profile: string): Promise<boolean> {
  const result = await awsApi.ssoLogin(profile);
  if (result.success) {
    invalidate((kind, args) => kind === awsIdentityR.kind && args[0] === profile);
    await fetchResource(awsIdentityR, profile, true).catch(() => {});
  }
  return result.success;
}

// ---- View state (per-pane) -------------------------------------------

export function setEditorView(
  paneId: string,
  patch: Partial<StoreState["editorViews"][string]>,
): void {
  setState((st) => {
    const cur = st.editorViews[paneId] ?? {
      openTabs: [],
      activePath: null,
      treeWidth: 210,
    };
    return {
      editorViews: { ...st.editorViews, [paneId]: { ...cur, ...patch } },
    };
  });
}

export function setGitView(
  paneId: string,
  patch: Partial<StoreState["gitViews"][string]>,
): void {
  setState((st) => {
    const cur: StoreState["gitViews"][string] = st.gitViews[paneId] ?? {
      panel: "files" as GitPanel,
      selected: { files: 0, branches: 0, commits: 0 },
    };
    return {
      gitViews: { ...st.gitViews, [paneId]: { ...cur, ...patch } },
    };
  });
}

export function setEcsLevel(paneId: string, level: EcsLevel): void {
  setState((st) => ({ ecsViews: { ...st.ecsViews, [paneId]: level } }));
}

export function setBillingExpandedMonth(
  profile: string,
  month: string | null,
): void {
  setState((st) => ({
    expandedBillingMonth: { ...st.expandedBillingMonth, [profile]: month },
  }));
}

// ---- Global search (Cmd+Shift+F) -------------------------------------

const DEFAULT_SEARCH_VIEW = {
  query: "",
  options: {
    caseSensitive: false,
    wholeWord: false,
    isRegex: false,
    include: "",
    exclude: "",
  },
  collapsed: {} as Record<string, boolean>,
};

function searchViewFor(sessionId: string) {
  const st = getState();
  return st.globalSearchBySession[sessionId] ?? DEFAULT_SEARCH_VIEW;
}

// Navigate the active project session to its search window. The pane is
// always present (created with the project, or migrated in on hydrate).
// No-op for non-project sessions, since there's nothing to search.
export function focusGlobalSearch(): void {
  const st = getState();
  const session = st.sessions[st.activeSessionId];
  if (!session || session.kind !== "project") return;
  const ids = st.windowsBySession[session.id] ?? [];
  const target = ids.find((id) => st.windows[id]?.role === "search");
  if (target) selectWindowId(target);
}

export function setGlobalSearchQuery(sessionId: string, query: string): void {
  const cur = searchViewFor(sessionId);
  setState((st) => ({
    globalSearchBySession: {
      ...st.globalSearchBySession,
      [sessionId]: { ...cur, query },
    },
  }));
}

export function setGlobalSearchOption<
  K extends keyof typeof DEFAULT_SEARCH_VIEW.options,
>(
  sessionId: string,
  key: K,
  value: (typeof DEFAULT_SEARCH_VIEW.options)[K],
): void {
  const cur = searchViewFor(sessionId);
  setState((st) => ({
    globalSearchBySession: {
      ...st.globalSearchBySession,
      [sessionId]: {
        ...cur,
        options: { ...cur.options, [key]: value },
      },
    },
  }));
}

export function toggleGlobalSearchFileCollapsed(
  sessionId: string,
  path: string,
): void {
  const cur = searchViewFor(sessionId);
  const wasCollapsed = !!cur.collapsed[path];
  const next = { ...cur.collapsed };
  if (wasCollapsed) delete next[path];
  else next[path] = true;
  setState((st) => ({
    globalSearchBySession: {
      ...st.globalSearchBySession,
      [sessionId]: { ...cur, collapsed: next },
    },
  }));
}

export function expandAllGlobalSearchFiles(sessionId: string): void {
  const cur = searchViewFor(sessionId);
  setState((st) => ({
    globalSearchBySession: {
      ...st.globalSearchBySession,
      [sessionId]: { ...cur, collapsed: {} },
    },
  }));
}

export function collapseAllGlobalSearchFiles(
  sessionId: string,
  paths: string[],
): void {
  const cur = searchViewFor(sessionId);
  const next: Record<string, boolean> = {};
  for (const p of paths) next[p] = true;
  setState((st) => ({
    globalSearchBySession: {
      ...st.globalSearchBySession,
      [sessionId]: { ...cur, collapsed: next },
    },
  }));
}

import { create } from "zustand";
import { enableMapSet, produce, type Draft } from "immer";
import { DEFAULT_THEME_ID } from "../themes";

// We do not currently put Map / Set into the store, but enabling this
// once is cheap and protects future code that does.
enableMapSet();
import { makePane, newId } from "./layout";
import type { GitCmdEntry, GitModal } from "./gitTypes";
import type {
  Agent,
  AgentBookmark,
  AwsService,
  EcsLevel,
  EditorPaneView,
  GitPaneView,
  GlobalSearchView,
  LspResults,
  PickerMode,
  ProjectRoot,
  RecentEntry,
  RundeckSettings,
  RundeckView,
  Session,
  Window,
} from "./types";

// One store, three namespaces:
//
//   domain  — persisted truth (sessions, windows, agents, prefs)
//   view    — ephemeral UI state, keyed by pane / session / profile
//
// Resources (remote-fetched data) live in state/resources.ts, not here.
// Cross-component signals (open-file, fs-changed, …) live in state/bus.ts.
//
// Mutations go through state/commands.ts. Reads go through state/selectors.ts.
// Components do not touch this file directly except for the `useStore` hook.

export interface DomainState {
  // Entities — flat maps keyed by id.
  sessions: Record<string, Session>;
  windows: Record<string, Window>;
  agents: Record<string, Agent>;

  // Order + ownership.
  sessionOrder: string[];
  windowsBySession: Record<string, string[]>;
  agentsBySession: Record<string, string[]>;

  // Top-level focus.
  activeSessionId: string;

  // Persisted history.
  recent: RecentEntry[];
  agentBookmarks: AgentBookmark[];

  // Persisted preferences (no separate "settings" namespace — they're just
  // domain knobs that happen not to be tied to a particular entity).
  projectRoots: ProjectRoot[];
  themeId: string;
  windowOpacity: number;
  windowBlur: number;
  cloudBrowser: string;
  cloudBrowserShortcut: string;
  awsProfile: string | null;
  awsService: AwsService;
  leftRailOpen: boolean;
  rightRailOpen: boolean;
  rundeck: RundeckSettings;
}

export interface ViewState {
  // Boot-time platform info.
  home: string;

  // Modal / overlay flags (ephemeral).
  pickerOpen: boolean;
  pickerMode: PickerMode;
  agentPaletteOpen: boolean;
  filePaletteOpen: boolean;
  settingsOpen: boolean;
  awsAuthModal: { profile: string; ssoStartUrl: string | null } | null;
  lspResults: LspResults | null;
  zoomedPaneId: string | null;

  // Per-pane view state. Pruned when the pane is destroyed.
  editorViews: Record<string, EditorPaneView>;
  gitViews: Record<string, GitPaneView>;
  ecsViews: Record<string, EcsLevel>;
  rundeckViews: Record<string, RundeckView>;
  expandedBillingMonth: Record<string, string | null>;

  // Git pane infrastructure: one modal at a time, app-wide. Imperative
  // helpers in state/git.ts set this. The renderer mounted inside
  // GitPane reads it and paints whichever variant is active.
  gitModal: GitModal | null;
  /** Append-only command log entries (ring-buffered to LOG_LIMIT in
   *  state/git.ts). Surfaced as a collapsible bar at the bottom of the
   *  git pane and toggled with `@`. */
  gitCmdLog: GitCmdEntry[];
  gitCmdLogOpen: boolean;

  // Per-project global search state — query + filters survive switching
  // away from the search window and across projects. The search pane
  // itself is just the project's 4th window (role: "search").
  globalSearchBySession: Record<string, GlobalSearchView>;

  // OTA: populated by api/updater.ts when a newer version is found.
  // Cleared on successful install (the new binary starts with `null`).
  // The TopBar UpdateChip renders whenever this is non-null.
  pendingUpdate: {
    version: string;
    currentVersion: string;
    notes: string | null;
    date: string | null;
    state: "available" | "installing" | "error";
    error: string | null;
  } | null;
}

export type StoreState = DomainState & ViewState;

// ---- Defaults / initial -------------------------------------------------

function initialSession(): {
  session: Session;
  window: Window;
} {
  const sessId = newId("sess");
  const pane = makePane("", { kind: "terminal" });
  const win: Window = {
    id: newId("win"),
    name: "1",
    role: "term",
    root: pane,
    activePaneId: pane.id,
  };
  const session: Session = {
    id: sessId,
    name: "main",
    kind: "command",
    cwd: "",
    env: "dev",
    pinned: false,
    activeWindowId: win.id,
    activeAgentId: null,
    view: "windows",
  };
  return { session, window: win };
}

export const useStore = create<StoreState>(() => {
  const { session, window } = initialSession();
  return {
    // domain
    sessions: { [session.id]: session },
    windows: { [window.id]: window },
    agents: {},
    sessionOrder: [session.id],
    windowsBySession: { [session.id]: [window.id] },
    agentsBySession: { [session.id]: [] },
    activeSessionId: session.id,
    recent: [],
    agentBookmarks: [],
    projectRoots: [],
    themeId: DEFAULT_THEME_ID,
    windowOpacity: 1,
    windowBlur: 0,
    cloudBrowser: "",
    cloudBrowserShortcut: "",
    awsProfile: null,
    awsService: "ecs",
    leftRailOpen: true,
    rightRailOpen: true,
    rundeck: {
      // Default to the dev legacy project on first launch. User picks
      // any project (and optional env folder for product projects) from
      // the tree sub-rail inside the Rundeck pane; selection persists.
      activeProject: "dev",
      activeEnvFolder: null,
      prodEnvs: ["prod", "production"],
    },

    // view
    home: "",
    pickerOpen: false,
    pickerMode: "all",
    agentPaletteOpen: false,
    filePaletteOpen: false,
    settingsOpen: false,
    awsAuthModal: null,
    lspResults: null,
    zoomedPaneId: null,
    editorViews: {},
    gitViews: {},
    ecsViews: {},
    rundeckViews: {},
    expandedBillingMonth: {},
    gitModal: null,
    gitCmdLog: [],
    gitCmdLogOpen: false,
    globalSearchBySession: {},
    pendingUpdate: null,
  };
});

// Convenience for non-React code (commands, persist, event handlers).
export const getState = useStore.getState;
export const setState = useStore.setState;

// Immer-backed mutator. Lets command code write nested updates as if
// they were mutable (`d.sessions[id].name = x`) and immer hands the
// store back a properly-immutable, structurally-shared next state.
// Unchanged subtrees keep their identity so the persist short-circuit
// (which compares slice references) keeps working, and React selectors
// only re-render where they actually need to.
//
// Use this in place of the deeply-spread `setState((st) => ({ a: { ...st.a,
// [id]: { ...st.a[id], k: v } } }))` patterns. Plain top-level patches
// (`setState({ pickerOpen: true })`) stay as-is — no need to convert.
export function mutate(fn: (draft: Draft<StoreState>) => void): void {
  setState((st) => produce(st, fn));
}

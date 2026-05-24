import { create } from "zustand";
import { DEFAULT_THEME_ID } from "../themes";
import { makePane, newId } from "./layout";
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
      // Sensible default mirroring the bash CLI's hardcoded mapping. Users
      // can edit via Settings → Rundeck once that lands.
      envs: [
        { label: "dev", project: "dev" },
        { label: "staging", project: "staging" },
        { label: "preprod", project: "Preprod" },
        { label: "prod", project: "production" },
      ],
      prodEnvs: ["prod", "production"],
      activeEnv: "dev",
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
    globalSearchBySession: {},
    pendingUpdate: null,
  };
});

// Convenience for non-React code (commands, persist, event handlers).
export const getState = useStore.getState;
export const setState = useStore.setState;

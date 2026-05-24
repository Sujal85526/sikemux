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
  LspResults,
  PickerMode,
  ProjectRoot,
  RecentEntry,
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
  expandedBillingMonth: Record<string, string | null>;
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
    expandedBillingMonth: {},
  };
});

// Convenience for non-React code (commands, persist, event handlers).
export const getState = useStore.getState;
export const setState = useStore.setState;

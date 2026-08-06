import { create } from "zustand";
import { enableMapSet, produce, type Draft } from "immer";
import { DEFAULT_THEME_ID, type Theme } from "../themes";
import type { KeybindingOverrides } from "../keybindings";

enableMapSet();
import { makePane, newId } from "./layout";
import type { GitCmdEntry, GitModal } from "./gitTypes";
import type {
    Agent,
    AwsService,
    EcsLevel,
    EditorPaneView,
    GitPaneView,
    BrunoView,
    GlobalSearchView,
    PickerMode,
    PinnedProject,
    ProjectRoot,
    RecentEntry,
    RundeckSettings,
    RundeckView,
    Session,
    SessionSwitcherView,
    Window,
} from "./types";

export interface DomainState {
    sessions: Record<string, Session>;
    windows: Record<string, Window>;
    agents: Record<string, Agent>;

    sessionOrder: string[];
    windowsBySession: Record<string, string[]>;
    agentsBySession: Record<string, string[]>;

    activeSessionId: string;

    recent: RecentEntry[];

    pinnedProjects: PinnedProject[];
    projectRoots: ProjectRoot[];
    /** Imported Bruno (API) workspace collection paths, most-recent-first. Survive session close so they stay reopenable. */
    brunoWorkspaces: string[];
    themeId: string;
    /** User-defined themes, derived from a built-in or another custom theme via the theme editor. */
    customThemes: Theme[];
    windowOpacity: number;
    windowBlur: number;
    cloudBrowser: string;
    cloudBrowserShortcut: string;
    keybindingOverrides: KeybindingOverrides;
    awsProfile: string | null;
    awsService: AwsService;
    leftRailOpen: boolean;
    rightRailOpen: boolean;
    zenMode: boolean;
    rundeck: RundeckSettings;
}

export interface ViewState {
    home: string;

    pickerOpen: boolean;
    pickerMode: PickerMode;
    agentPaletteOpen: boolean;
    filePaletteOpen: boolean;
    rundeckJobPaletteOpen: boolean;
    brunoReqPaletteOpen: boolean;
    brunoEnvPaletteOpen: boolean;
    settingsOpen: boolean;
    awsAuthModal: { profile: string; ssoStartUrl: string | null } | null;
    zoomedPaneId: string | null;
    sessionSwitcher: SessionSwitcherView | null;

    editorViews: Record<string, EditorPaneView>;
    dirtyEditorPaths: Record<string, string[]>;
    gitViews: Record<string, GitPaneView>;
    ecsViews: Record<string, EcsLevel>;
    rundeckViews: Record<string, RundeckView>;
    brunoViews: Record<string, BrunoView>;
    expandedBillingMonth: Record<string, string | null>;

    gitModal: GitModal | null;
    gitCmdLog: GitCmdEntry[];
    gitCmdLogOpen: boolean;

    globalSearchBySession: Record<string, GlobalSearchView>;

    /** Runtime-only PTY activity for live agents. Never persisted or hydrated. */
    agentActivity: Record<
        string,
        {
            state: "idle" | "working" | "complete";
            unread: boolean;
            updatedAt: number;
        }
    >;

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
        deploy: null,
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
        sessions: { [session.id]: session },
        windows: { [window.id]: window },
        agents: {},
        sessionOrder: [session.id],
        windowsBySession: { [session.id]: [window.id] },
        agentsBySession: { [session.id]: [] },
        activeSessionId: session.id,
        recent: [],
        pinnedProjects: [],
        projectRoots: [],
        brunoWorkspaces: [],
        themeId: DEFAULT_THEME_ID,
        customThemes: [],
        windowOpacity: 1,
        windowBlur: 0,
        cloudBrowser: "",
        cloudBrowserShortcut: "",
        keybindingOverrides: {},
        awsProfile: null,
        awsService: "ecs",
        leftRailOpen: true,
        rightRailOpen: true,
        zenMode: false,
        rundeck: {
            activeProject: "",
            activeEnvFolder: null,
            prodEnvs: ["prod", "production"],
        },

        home: "",
        pickerOpen: false,
        pickerMode: "all",
        agentPaletteOpen: false,
        filePaletteOpen: false,
        rundeckJobPaletteOpen: false,
        brunoReqPaletteOpen: false,
        brunoEnvPaletteOpen: false,
        settingsOpen: false,
        awsAuthModal: null,
        zoomedPaneId: null,
        sessionSwitcher: null,
        editorViews: {},
        dirtyEditorPaths: {},
        gitViews: {},
        ecsViews: {},
        rundeckViews: {},
        brunoViews: {},
        expandedBillingMonth: {},
        gitModal: null,
        gitCmdLog: [],
        gitCmdLogOpen: false,
        globalSearchBySession: {},
        agentActivity: {},
        pendingUpdate: null,
    };
});

export const getState = useStore.getState;
export const setState = useStore.setState;

export function mutate(fn: (draft: Draft<StoreState>) => void): void {
    setState((st) => produce(st, fn));
}

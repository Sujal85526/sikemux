import type { Agent, AgentBookmark, AwsService, ProjectRoot, RecentEntry, RundeckSettings, Session, Window } from "./domain";
import type { EditorPaneView } from "./view";

export interface PersistedSnapshot {
    version: number;
    sessions: Session[];
    windowsBySession: Record<string, Window[]>;
    agentsBySession: Record<string, Agent[]>;
    sessionOrder: string[];
    activeSessionId: string;
    recent: RecentEntry[];
    agentBookmarks: AgentBookmark[];
    prefs: PersistedPrefs;
    editorViews: Record<string, EditorPaneView>;
}

export interface PersistedPrefs {
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
    zenMode: boolean;
    rundeck?: RundeckSettings;
}

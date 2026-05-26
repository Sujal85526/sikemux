// Wire shape for the persisted state blob.
//
// Bumping `VERSION` in `state/persist.ts` is the contract change — any
// addition / removal / type-change to a field below MUST come with a
// version bump and a migration in `applyHydrate`. Older blobs whose
// version doesn't match are silently discarded.

import type {
  Agent,
  AgentBookmark,
  AwsService,
  ProjectRoot,
  RecentEntry,
  RundeckSettings,
  Session,
  Window,
} from "./domain";
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
  rundeck?: RundeckSettings;
}

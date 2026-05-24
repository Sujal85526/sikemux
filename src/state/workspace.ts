import { create } from "zustand";
import type { Session } from "./types";
import { createUiSlice, type UiSlice } from "./slices/ui";
import { createSessionsSlice, type SessionsSlice } from "./slices/sessions";
import { createLayoutSlice, type LayoutSlice } from "./slices/layout";
import { createAgentsSlice, type AgentsSlice } from "./slices/agents";
import {
  createSettingsSlice,
  type SettingsSlice,
} from "./slices/settings";
import { createAwsSlice, type AwsSlice } from "./slices/aws";

export type WorkspaceStore = UiSlice &
  SessionsSlice &
  LayoutSlice &
  AgentsSlice &
  SettingsSlice &
  AwsSlice;

export const useWorkspace = create<WorkspaceStore>()((...a) => ({
  ...createUiSlice(...a),
  ...createSessionsSlice(...a),
  ...createLayoutSlice(...a),
  ...createAgentsSlice(...a),
  ...createSettingsSlice(...a),
  ...createAwsSlice(...a),
}));

// ---- selectors ----------------------------------------------------------

export const selectActiveSession = (s: WorkspaceStore): Session =>
  s.sessions[s.activeSessionId];

export function getOrderedSessions(s: WorkspaceStore): Session[] {
  return s.sessionOrder.map((id) => s.sessions[id]);
}

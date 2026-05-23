import { create } from "zustand";
import type { Session } from "./types";
import { createUiSlice, type UiSlice } from "./slices/ui";
import { createSessionsSlice, type SessionsSlice } from "./slices/sessions";
import { createLayoutSlice, type LayoutSlice } from "./slices/layout";
import { createAgentsSlice, type AgentsSlice } from "./slices/agents";

export type WorkspaceStore = UiSlice & SessionsSlice & LayoutSlice & AgentsSlice;

export const useWorkspace = create<WorkspaceStore>()((...a) => ({
  ...createUiSlice(...a),
  ...createSessionsSlice(...a),
  ...createLayoutSlice(...a),
  ...createAgentsSlice(...a),
}));

// ---- selectors ----------------------------------------------------------

export const selectActiveSession = (s: WorkspaceStore): Session =>
  s.sessions[s.activeSessionId];

export function getOrderedSessions(s: WorkspaceStore): Session[] {
  return s.sessionOrder.map((id) => s.sessions[id]);
}

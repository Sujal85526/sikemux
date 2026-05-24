import { useStore, type StoreState } from "./store";
import type { Agent, Session, Window } from "./types";

// All store reads flow through here. Components import only the hooks
// below — they never reach into the store directly. Selectors are simple
// closures over the store state and rely on Zustand's Object.is equality
// to suppress no-op re-renders.

// ---- Atomic primitives -------------------------------------------------

export const useActiveSessionId = (): string =>
  useStore((s) => s.activeSessionId);

export const useSessionOrder = (): string[] =>
  useStore((s) => s.sessionOrder);

export const useSession = (id: string): Session | undefined =>
  useStore((s) => s.sessions[id]);

export const useActiveSession = (): Session =>
  useStore((s) => s.sessions[s.activeSessionId]);

export const useWindow = (id: string): Window | undefined =>
  useStore((s) => s.windows[id]);

export const useAgent = (id: string): Agent | undefined =>
  useStore((s) => s.agents[id]);

export const useWindowIdsFor = (sessionId: string): string[] =>
  useStore((s) => s.windowsBySession[sessionId] ?? EMPTY);

export const useAgentIdsFor = (sessionId: string): string[] =>
  useStore((s) => s.agentsBySession[sessionId] ?? EMPTY);

// Stable empty-array sentinel so the selector returns Object.is-equal
// across re-renders when a session has no windows/agents yet.
const EMPTY: string[] = [];

// ---- Aggregations -------------------------------------------------------

/** Returns the ordered list of sessions (objects). */
export function selectOrderedSessions(s: StoreState): Session[] {
  return s.sessionOrder.map((id) => s.sessions[id]);
}

/** Resolves the active session's windows, in display order. */
export function selectActiveWindows(s: StoreState): Window[] {
  return (s.windowsBySession[s.activeSessionId] ?? []).map(
    (id) => s.windows[id],
  );
}

/** Resolves the active session's agents. */
export function selectActiveAgents(s: StoreState): Agent[] {
  return (s.agentsBySession[s.activeSessionId] ?? []).map(
    (id) => s.agents[id],
  );
}

/** Cross-session lookup: which agents are live, keyed by `${type}:${bmId}`. */
export function selectLiveAgentMap(s: StoreState): Map<string, string> {
  const out = new Map<string, string>();
  for (const sid of s.sessionOrder) {
    const sess = s.sessions[sid];
    if (sess.kind !== "project") continue;
    const ids = s.agentsBySession[sid] ?? [];
    for (const aid of ids) {
      const a = s.agents[aid];
      if (a) out.set(`${a.type}:${a.resumeId ?? a.id}`, a.id);
    }
  }
  return out;
}

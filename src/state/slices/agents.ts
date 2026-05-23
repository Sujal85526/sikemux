import type { Agent, AgentBookmark, AgentType } from "../types";
import { newId } from "../layout";
import type { Slice } from "./types";

function agentStartup(type: AgentType, resumeId?: string): string {
  if (!resumeId) return type;
  if (type === "claude") return `claude --resume ${resumeId}`;
  if (type === "codex") return `codex resume ${resumeId}`;
  if (type === "hermes") return `hermes --resume ${resumeId}`;
  return type;
}

function makeAgent(type: AgentType, resumeId?: string, title?: string): Agent {
  return {
    id: newId("agent"),
    type,
    title: title ?? type,
    startup: agentStartup(type, resumeId),
    resumeId,
  };
}

const bmIdOf = (a: Agent) => a.resumeId ?? a.id;

export interface AgentsSlice {
  agentBookmarks: AgentBookmark[];

  addAgent: (type: AgentType, resumeId?: string, title?: string) => void;
  selectAgent: (id: string) => void;
  closeAgent: (id: string) => void;
  focusAgents: () => void;
  toggleAgentBookmark: (b: AgentBookmark) => void;
  openAgentBookmark: (b: AgentBookmark) => void;
}

export const createAgentsSlice: Slice<AgentsSlice> = (set, get) => ({
  agentBookmarks: [],

  addAgent: (type, resumeId, title) =>
    set((st) => {
      const s = st.sessions[st.activeSessionId];
      if (!s || s.kind !== "project") return {};
      const existing = resumeId
        ? s.agents.find((a) => a.type === type && a.resumeId === resumeId)
        : undefined;
      if (existing) {
        return {
          zoomedPaneId: null,
          sessions: {
            ...st.sessions,
            [s.id]: { ...s, activeAgentId: existing.id, view: "agent" },
          },
        };
      }
      const agent = makeAgent(type, resumeId, title);
      return {
        zoomedPaneId: null,
        sessions: {
          ...st.sessions,
          [s.id]: {
            ...s,
            agents: [...s.agents, agent],
            activeAgentId: agent.id,
            view: "agent",
          },
        },
      };
    }),

  selectAgent: (id) =>
    get().patchActiveSession((s) => ({ ...s, activeAgentId: id, view: "agent" })),

  closeAgent: (id) =>
    set((st) => {
      const ownerId = st.sessionOrder.find((sid) =>
        st.sessions[sid].agents.some((a) => a.id === id),
      );
      if (!ownerId) return {};
      const owner = st.sessions[ownerId];
      const agents = owner.agents.filter((a) => a.id !== id);
      const wasActive = owner.activeAgentId === id;
      return {
        sessions: {
          ...st.sessions,
          [ownerId]: {
            ...owner,
            agents,
            activeAgentId: wasActive ? (agents[0]?.id ?? null) : owner.activeAgentId,
            view: wasActive && agents.length === 0 ? "windows" : owner.view,
          },
        },
      };
    }),

  focusAgents: () =>
    set((st) => {
      const s = st.sessions[st.activeSessionId];
      if (!s) return {};
      return {
        agentFocusN: st.agentFocusN + 1,
        zoomedPaneId: null,
        sessions: {
          ...st.sessions,
          [s.id]: {
            ...s,
            view: "agent",
            activeAgentId: s.activeAgentId ?? (s.agents[0]?.id ?? null),
          },
        },
      };
    }),

  toggleAgentBookmark: (b) =>
    set((st) => {
      const has = st.agentBookmarks.some(
        (x) => x.type === b.type && x.id === b.id,
      );
      return {
        agentBookmarks: has
          ? st.agentBookmarks.filter(
              (x) => !(x.type === b.type && x.id === b.id),
            )
          : [b, ...st.agentBookmarks],
      };
    }),

  openAgentBookmark: (b) => {
    const st = get();

    // 1. Already running anywhere? Jump to its owning session and focus.
    for (const id of st.sessionOrder) {
      const s = st.sessions[id];
      if (s.kind !== "project") continue;
      const agent = s.agents.find(
        (a) => a.type === b.type && a.resumeId === b.id,
      );
      if (agent) {
        set((cur) => ({
          activeSessionId: s.id,
          zoomedPaneId: null,
          sessions: {
            ...cur.sessions,
            [s.id]: { ...cur.sessions[s.id], activeAgentId: agent.id, view: "agent" },
          },
        }));
        return;
      }
    }

    // 2. Switch to the bookmark's project (existing or new).
    if (b.cwd) {
      const cur = get();
      const existing = cur.sessionOrder
        .map((id) => cur.sessions[id])
        .find((s) => s.kind === "project" && s.cwd === b.cwd);
      if (existing) {
        if (existing.id !== cur.activeSessionId) {
          set({ activeSessionId: existing.id, zoomedPaneId: null });
        }
      } else {
        cur.createProjectSession(b.cwd);
      }
    }

    // 3. Link to a fresh agent of the same type if exactly one exists.
    const isFreshBookmark = b.id.startsWith("agent-");
    if (!isFreshBookmark) {
      const cur = get();
      const dest = cur.sessions[cur.activeSessionId];
      if (dest && dest.kind === "project") {
        const freshs = dest.agents.filter(
          (a) => a.type === b.type && !a.resumeId,
        );
        if (freshs.length === 1) {
          const fresh = freshs[0];
          set((c2) => ({
            sessions: {
              ...c2.sessions,
              [dest.id]: {
                ...c2.sessions[dest.id],
                activeAgentId: fresh.id,
                view: "agent",
                agents: c2.sessions[dest.id].agents.map((a) =>
                  a.id === fresh.id
                    ? { ...a, resumeId: b.id, title: b.title }
                    : a,
                ),
              },
            },
          }));
          return;
        }
      }
    }

    // 4. Spawn (addAgent's own dedup covers any miss).
    if (isFreshBookmark) get().addAgent(b.type);
    else get().addAgent(b.type, b.id, b.title);
  },
});

export { bmIdOf };

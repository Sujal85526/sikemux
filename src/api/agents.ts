import { invoke } from "@tauri-apps/api/core";

// An existing on-disk conversation that can be resumed.
export interface AgentSession {
    id: string;
    title: string;
    mtime: number; // unix seconds
}

// Coalesce concurrent fetches of the same (agent, cwd) — the AgentRail,
// AgentPalette and SeshPicker can all ask at once, but only one IPC trip
// should actually fire. Bounded TTL also collapses fast-fire refetches.
const inflight = new Map<string, Promise<AgentSession[]>>();
const cache = new Map<string, { at: number; data: AgentSession[] }>();
const TTL_MS = 2_000;

function key(agent: string, cwd: string) {
    return `${agent}\0${cwd}`;
}

async function fetchSessions(agent: string, cwd: string): Promise<AgentSession[]> {
    const k = key(agent, cwd);
    const now = Date.now();
    const cached = cache.get(k);
    if (cached && now - cached.at < TTL_MS) return cached.data;
    const existing = inflight.get(k);
    if (existing) return existing;
    const p = invoke<AgentSession[]>("agent_sessions", { agent, cwd })
        .then((data) => {
            cache.set(k, { at: Date.now(), data });
            return data;
        })
        .finally(() => {
            inflight.delete(k);
        });
    inflight.set(k, p);
    return p;
}

export const agentApi = {
    sessions: fetchSessions,
    invalidate: (agent?: string, cwd?: string) => {
        if (agent == null || cwd == null) {
            cache.clear();
            return;
        }
        cache.delete(key(agent, cwd));
    },
};

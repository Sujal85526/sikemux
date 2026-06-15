import { invoke } from "@tauri-apps/api/core";
import type { AgentType } from "../state/types";

export interface AgentInfo {
    type: AgentType;
    label: string;
    command: string;
}

export interface AgentSession {
    id: string;
    title: string;
    mtime: number; // unix seconds
}

const inflight = new Map<string, Promise<AgentSession[]>>();

function key(agent: string, cwd: string) {
    return `${agent}\0${cwd}`;
}

async function fetchAvailable(): Promise<AgentInfo[]> {
    return invoke<AgentInfo[]>("available_agents");
}

async function fetchSessions(agent: string, cwd: string): Promise<AgentSession[]> {
    const k = key(agent, cwd);
    const existing = inflight.get(k);
    if (existing) return existing;
    const p = invoke<AgentSession[]>("agent_sessions", { agent, cwd })
        .finally(() => {
            inflight.delete(k);
        });
    inflight.set(k, p);
    return p;
}

export const agentApi = {
    available: fetchAvailable,
    sessions: fetchSessions,
    watchStart: (agent: AgentType, cwd: string): Promise<number> => invoke<number>("agent_sessions_watch_start", { agent, cwd }),
    watchStop: (id: number): Promise<void> => invoke<void>("agent_sessions_watch_stop", { id }),
};

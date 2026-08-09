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

/** A provider-scoped history result. Errors intentionally stay opaque to UI code. */
export type AgentSessionProviderResult =
    { provider: AgentInfo; status: "success"; sessions: AgentSession[] } | { provider: AgentInfo; status: "error"; sessions: [] };

const inflight = new Map<string, Promise<AgentSession[]>>();
const HISTORY_TIMEOUT_MS = 8_000;

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
    const p = invoke<AgentSession[]>("agent_sessions", { agent, cwd }).finally(() => {
        inflight.delete(k);
    });
    inflight.set(k, p);
    return p;
}

async function fetchSessionResults(providers: readonly AgentInfo[], cwd: string): Promise<AgentSessionProviderResult[]> {
    return Promise.all(
        providers.map(async (provider): Promise<AgentSessionProviderResult> => {
            try {
                let timer: ReturnType<typeof setTimeout> | undefined;
                const timeout = new Promise<never>((_resolve, reject) => {
                    timer = setTimeout(() => reject(new Error("agent history timed out")), HISTORY_TIMEOUT_MS);
                });
                const sessions = await Promise.race([fetchSessions(provider.type, cwd), timeout]).finally(() => {
                    if (timer) clearTimeout(timer);
                });
                return { provider, status: "success", sessions };
            } catch {
                return { provider, status: "error", sessions: [] };
            }
        }),
    );
}

export const agentApi = {
    available: fetchAvailable,
    sessions: fetchSessions,
    sessionResults: fetchSessionResults,
    watchStart: (agent: AgentType, cwd: string): Promise<number> => invoke<number>("agent_sessions_watch_start", { agent, cwd }),
    watchStop: (id: number): Promise<void> => invoke<void>("agent_sessions_watch_stop", { id }),
};

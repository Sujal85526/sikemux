import { invoke } from "@tauri-apps/api/core";

// An existing on-disk conversation that can be resumed.
export interface AgentSession {
  id: string;
  title: string;
  mtime: number; // unix seconds
}

export const agentApi = {
  sessions: (agent: string, cwd: string) =>
    invoke<AgentSession[]>("agent_sessions", { agent, cwd }),
};

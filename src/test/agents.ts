import { agentWindow } from "../state/agentWindow";
import type { StoreState } from "../state/store";
import type { Agent } from "../state/types";

type AgentSlices = Pick<StoreState, "windows" | "windowsBySession" | "agents">;

/** The slices that put `agents` in `sessionId`, each as a window appended in order. */
export function withAgents(state: AgentSlices, sessionId: string, agents: Agent[], cwd = ""): AgentSlices {
    const windows = { ...state.windows };
    const ids = [...(state.windowsBySession[sessionId] ?? [])];
    const byId = { ...state.agents };
    for (const agent of agents) {
        const win = agentWindow(agent, agent.cwd ?? cwd);
        windows[win.id] = win;
        ids.push(win.id);
        byId[agent.id] = agent;
    }
    return { windows, windowsBySession: { ...state.windowsBySession, [sessionId]: ids }, agents: byId };
}

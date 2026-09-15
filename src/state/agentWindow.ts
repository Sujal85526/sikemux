import { newId } from "./layout";
import type { Agent, Window } from "./types";

/**
 * The window an agent lives in: one pane, of kind `agent`, whose id is the
 * agent's own so `agents[pane.id]` is its record. Nothing else about an agent
 * is special to the stage.
 */
export function agentWindow(agent: Pick<Agent, "id" | "title">, cwd: string): Window {
    return {
        id: newId("win"),
        name: agent.title,
        role: "agent",
        root: { type: "pane", id: agent.id, cwd, kind: "agent", title: agent.title },
        activePaneId: agent.id,
    };
}

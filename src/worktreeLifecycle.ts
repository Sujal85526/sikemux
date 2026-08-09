import type { StoreState } from "./state/store";

export function worktreeHasLiveOwners(state: Pick<StoreState, "sessions" | "agents">, path: string): boolean {
    const hasProject = Object.values(state.sessions).some((session) => session.kind === "project" && session.cwd === path);
    if (hasProject) return true;
    return Object.values(state.agents).some((agent) => agent.cwd === path || agent.worktreePath === path);
}

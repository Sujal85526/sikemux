import { useMemo } from "react";
import type { AgentInfo } from "../api/agents";
import { agentHistoryR } from "../state/resources.defs";
import { useResourceEnabled } from "../state/resources";
import { useStore } from "../state/store";
import { agentIdsOf } from "../state/selectors";
import type { Agent, AgentType, Session } from "../state/types";

/** A chat this project has on disk and does not have open. */
export interface PastChat {
    id: string;
    title: string;
    /** Unix seconds. */
    mtime: number;
    type: AgentType;
}

export interface AgentLog {
    /** Running now, newest window last — the order the session opened them. */
    open: Agent[];
    /** Everything else this checkout has, newest first. */
    past: PastChat[];
    loading: boolean;
}

const EMPTY: AgentInfo[] = [];

/**
 * Hermes keeps one history for the machine rather than one per checkout, so a
 * project-scoped list would fill up with chats from unrelated repositories.
 * The palette leaves it out for the same reason.
 */
const projectScoped = (agent: AgentInfo) => agent.available !== false && agent.type !== "hermes";

/** What a chat is called on disk, which is not its window id once it is open. */
const persistedIdOf = (agent: Agent) => agent.resumeId ?? agent.id;

/**
 * One list of every chat a project has — the ones running and the ones on disk,
 * all providers together, newest first.
 *
 * The rail shows them as one run of rows and lets weight say which is which, so
 * it has no use for a per-provider split. Which CLI wrote a chat is a property
 * of the row, not a filing system for it.
 */
export function useAgentLog(session: Session | undefined, providers: AgentInfo[]): AgentLog {
    const windowsBySession = useStore((s) => s.windowsBySession);
    const windowsById = useStore((s) => s.windows);
    const agentsById = useStore((s) => s.agents);

    const isProject = session?.kind === "project";
    const cwd = isProject ? (session?.cwd ?? "") : "";
    const scoped = useMemo(() => providers.filter(projectScoped), [providers]);
    const history = useResourceEnabled(Boolean(cwd) && scoped.length > 0, agentHistoryR, scoped, cwd);

    const open = useMemo(() => {
        if (!session || !isProject) return [];
        return agentIdsOf({ windowsBySession, windows: windowsById }, session.id)
            .map((id) => agentsById[id])
            .filter(Boolean) as Agent[];
    }, [session, isProject, windowsBySession, windowsById, agentsById]);

    const past = useMemo(() => {
        const running = new Set(open.map((agent) => `${agent.type}\0${persistedIdOf(agent)}`));
        return (history.data ?? [])
            .flatMap((result) => result.sessions.map((row): PastChat => ({ ...row, type: result.provider.type })))
            .filter((row) => !running.has(`${row.type}\0${row.id}`))
            .sort((a, b) => b.mtime - a.mtime);
    }, [history.data, open]);

    return { open, past, loading: history.status === "loading" };
}

export { EMPTY as NO_PROVIDERS };

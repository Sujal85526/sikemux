import { useEffect, useMemo, useRef, useState } from "react";
import { agentCwd } from "../agents/agentPtyContext";
import { agentNamesApi, type NameRequest } from "../api/agentNames";
import * as cmd from "../state/commands";
import { agentIdsOf } from "../state/selectors";
import { useStore, type StoreState } from "../state/store";
import { swallow } from "../state/toast";

const RETRY_MS = 3_000;

function nameRequests(state: Pick<StoreState, "agents" | "windows" | "sessions" | "sessionOrder" | "windowsBySession">): NameRequest[] {
    return state.sessionOrder.flatMap((sessionId) => {
        const session = state.sessions[sessionId];
        if (!session) return [];
        return agentIdsOf(state, sessionId).flatMap((agentId) => {
            const agent = state.agents[agentId];
            const cwd = agent && agentCwd(agent, session);
            if (!agent || !cwd) return [];
            return [{ agentId, cwd, provider: agent.type, ...(agent.resumeId ? { resumeId: agent.resumeId } : {}) }];
        });
    });
}

/**
 * Tells the core every agent the app holds, then asks for each one's name. The core names an agent as it starts; this
 * also names the ones restored from before, and tells the core which provider session each runs so a chat opened again
 * gets its old name back.
 */
export function AgentNameBridge() {
    const agents = useStore((s) => s.agents);
    const windows = useStore((s) => s.windows);
    const sessions = useStore((s) => s.sessions);
    const sessionOrder = useStore((s) => s.sessionOrder);
    const windowsBySession = useStore((s) => s.windowsBySession);
    const held = useMemo(() => JSON.stringify(Object.keys(agents).sort()), [agents]);
    const requests = useMemo(
        () => JSON.stringify(nameRequests({ agents, windows, sessions, sessionOrder, windowsBySession })),
        [agents, windows, sessions, sessionOrder, windowsBySession],
    );
    const told = useRef<Promise<unknown>>(Promise.resolve());
    const asked = useRef(new Map<string, string>());
    const [retries, setRetries] = useState(0);

    useEffect(() => {
        told.current = agentNamesApi.inApp(JSON.parse(held) as string[]).catch(swallow("tell the core which agents the app holds"));
    }, [held]);

    useEffect(() => {
        let retry: number | undefined;
        for (const request of JSON.parse(requests) as NameRequest[]) {
            const key = JSON.stringify(request);
            if (asked.current.get(request.agentId) === key) continue;
            asked.current.set(request.agentId, key);
            told.current
                .then(() => agentNamesApi.name(request))
                .then(
                    (named) => cmd.setAgentName(request.agentId, named.name),
                    (error: unknown) => {
                        asked.current.delete(request.agentId);
                        swallow("name an agent")(error);
                        window.clearTimeout(retry);
                        retry = window.setTimeout(() => setRetries((count) => count + 1), RETRY_MS);
                    },
                );
        }
        return () => window.clearTimeout(retry);
    }, [requests, retries]);

    return null;
}

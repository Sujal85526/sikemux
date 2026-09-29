import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject } from "react";
import { acpApi } from "../api/acp";
import type { Agent } from "../state/types";
import * as cmd from "../state/commands";
import { combineQueued, nextBatch, type QueuedMessage } from "./queuedMessages";
import type { AcpAvailableCommand, ChatAction, ChatState } from "./types";

export function usePromptQueue({
    agentRef,
    agentId,
    cwd,
    connection,
    running,
    commands,
    steerable,
    dispatch,
    onError,
}: {
    agentRef: RefObject<Agent>;
    agentId: string;
    cwd: string;
    connection: ChatState["connection"];
    running: boolean;
    commands: AcpAvailableCommand[];
    steerable: boolean;
    dispatch: Dispatch<ChatAction>;
    onError: (message: string | null) => void;
}) {
    const [queued, setQueued] = useState<QueuedMessage[]>([]);
    const queuedCount = useRef(0);

    useEffect(() => setQueued([]), [agentId, cwd]);

    const promptNow = useCallback(
        async (text: string, paths: string[]) => {
            dispatch({ type: "local_prompt", text, paths });
            cmd.titleAgentFromPrompt(agentRef.current.id, text);
            try {
                await acpApi.prompt(agentRef.current.id, text, paths);
            } catch (error) {
                dispatch({ type: "error", message: error instanceof Error ? error.message : String(error) });
            }
        },
        [agentRef, dispatch],
    );

    /* Messages written mid-turn wait, then go out together as one prompt once
       the running turn ends, so nothing in flight is cut short. */
    useEffect(() => {
        if (connection !== "ready" || running || queued.length === 0) return;
        const batch = nextBatch(queued);
        const sent = new Set(batch.map((message) => message.id));
        setQueued((current) => current.filter((message) => !sent.has(message.id)));
        const next = combineQueued(batch);
        void promptNow(next.text, next.paths);
    }, [promptNow, queued, connection, running]);

    /* Steering stops whatever the agent has in flight so it reads this message
       now, so a message only goes this way when it is asked to. */
    const steer = async (messages: QueuedMessage[]) => {
        const steered = new Set(messages.map((message) => message.id));
        setQueued((current) => current.filter((candidate) => !steered.has(candidate.id)));
        const message = combineQueued(messages);
        dispatch({ type: "local_prompt", text: message.text, paths: message.paths });
        try {
            if ((await acpApi.steer(agentId, message.text, message.paths)) !== "promptRequired") return;
            await acpApi.prompt(agentId, message.text, message.paths);
        } catch (error) {
            dispatch({ type: "error", message: error instanceof Error ? error.message : String(error) });
        }
    };

    /** Says whether the composer may clear what it just handed over. */
    const send = (text: string, paths: string[], steerNow: boolean): boolean => {
        const commandName = text.match(/^\/([^\s]+)/)?.[1];
        if (commandName && commands.length > 0 && !commands.some((command) => command.name === commandName)) {
            onError(`/${commandName} is not available in this session`);
            return false;
        }
        onError(null);
        if (connection === "ready" && !running) {
            void promptNow(text, paths);
            return true;
        }

        /* Written mid-turn, or while the session is still coming up: it waits
           in the queue and goes out with the rest of it once the session is free. */
        queuedCount.current += 1;
        const message: QueuedMessage = { id: `queued-${queuedCount.current}`, text, paths };
        if (steerNow && steerable && running) {
            void steer([...queued, message]);
            return true;
        }
        setQueued((current) => [...current, message]);
        return true;
    };

    const drop = (id: string) => setQueued((current) => current.filter((message) => message.id !== id));

    return { queued, send, steer, drop };
}

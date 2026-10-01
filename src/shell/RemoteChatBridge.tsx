import { useEffect } from "react";
import type { AcpChat } from "../api/acp";
import { getIpcTransport } from "../api/transport";
import * as cmd from "../state/commands";
import { swallow } from "../state/toast";

export const REMOTE_CHAT_BEGUN_EVENT = "remote_chat_begun";

/** Shows a chat a paired phone starts while this window is open among its project's agents. */
export function RemoteChatBridge() {
    useEffect(() => {
        const controller = new AbortController();
        getIpcTransport()
            .subscribe<AcpChat>(REMOTE_CHAT_BEGUN_EVENT, (event) => void cmd.adoptChat(event.payload), { signal: controller.signal })
            .catch((error: unknown) => {
                if (!controller.signal.aborted) swallow("remote chat listener")(error);
            });
        return () => controller.abort();
    }, []);
    return null;
}

import { useSyncExternalStore } from "react";
import { coreSessionsApi, type SshLink } from "../api/coreSessions";
import { getIpcTransport } from "../api/transport";
import { collectPanes } from "../state/layout";
import { useStore, type StoreState } from "../state/store";
import { swallow } from "../state/toast";
import type { StatusTone } from "../ui/StatusDot";

/** Only terminals whose SSH is up or on its way; any other terminal counts as disconnected. */
const live = new Map<number, Exclude<SshLink, "disconnected">>();
const listeners = new Set<() => void>();

function note(ptyId: number, link: SshLink): void {
    if (live.get(ptyId) === link || (link === "disconnected" && !live.has(ptyId))) return;
    if (link === "disconnected") live.delete(ptyId);
    else live.set(ptyId, link);
    for (const listener of [...listeners]) listener();
}

/** Follows every SSH terminal for as long as the page runs, shown or not. */
export function watchSshLinks(): () => void {
    const controller = new AbortController();
    const { signal } = controller;
    const transport = getIpcTransport();
    const fail = (error: unknown) => {
        if (!signal.aborted) swallow("ssh link listener")(error);
    };
    void transport
        .subscribe<{ id: number; link: SshLink }>("pty_ssh_link", (event) => note(event.payload.id, event.payload.link), { signal })
        .catch(fail);
    void transport.subscribe<{ id: number }>("pty_exited", (event) => note(event.payload.id, "disconnected"), { signal }).catch(fail);
    void coreSessionsApi
        .list()
        .then((sessions) => {
            for (const session of sessions)
                if (session.ssh && session.running && !live.has(session.id) && !signal.aborted) note(session.id, session.ssh);
        })
        .catch(fail);
    return () => controller.abort();
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** The session's terminals, as one string so a store selector over it stays equal while they do. */
function sessionPtyIds(state: StoreState, sessionId: string): string {
    const ids: number[] = [];
    for (const windowId of state.windowsBySession[sessionId] ?? []) {
        const window = state.windows[windowId];
        if (window) for (const pane of collectPanes(window.root)) if (pane.ptyId !== undefined) ids.push(pane.ptyId);
    }
    return ids.join(",");
}

function toneOf(ptyIds: string): StatusTone {
    const links = ptyIds ? ptyIds.split(",").map((id) => live.get(Number(id))) : [];
    if (links.includes("connected")) return "ok";
    if (links.includes("connecting")) return "pending";
    return "off";
}

export function useSshTone(sessionId: string): StatusTone {
    const ptyIds = useStore((state) => sessionPtyIds(state, sessionId));
    return useSyncExternalStore(subscribe, () => toneOf(ptyIds));
}

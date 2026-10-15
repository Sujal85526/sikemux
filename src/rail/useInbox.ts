import { useSyncExternalStore } from "react";
import { INBOX_EVENT, inboxApi, type Inbox, type InboxDigest, type InboxItem } from "../api/inbox";
import { getIpcTransport } from "../api/transport";
import { swallow } from "../state/toast";

interface InboxState {
    inbox: Inbox;
    /** What happened while the person was away, until they dismiss it. */
    digest: InboxDigest | null;
}

let state: InboxState = { inbox: { items: [], working: 0, away: false, agentMessages: {} }, digest: null };
const listeners = new Set<() => void>();
let started = false;

function set(next: Partial<InboxState>): void {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
}

function take(inbox: Inbox): void {
    const back = state.inbox.away && !inbox.away;
    set(inbox.away ? { inbox, digest: null } : { inbox });
    if (!back) return;
    inboxApi
        .digest()
        .then((digest) => {
            if (!state.inbox.away && digest.finished.length + digest.failed.length > 0) set({ digest });
        })
        .catch(swallow("read the inbox digest"));
}

function start(): void {
    started = true;
    void getIpcTransport()
        .subscribe<Inbox>(INBOX_EVENT, (event) => take(event.payload))
        .then(() => inboxApi.read())
        .then(take)
        .catch(swallow("read the inbox"));
}

function subscribe(listener: () => void): () => void {
    if (!started) start();
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** The core's inbox, kept for the whole app once anything reads it. */
export function useInbox(): InboxState {
    return useSyncExternalStore(subscribe, () => state);
}

export function dismissDigest(): void {
    set({ digest: null });
}

/** Agents in the order the inbox lists them; those it does not list keep their order after it. */
export function inInboxOrder<T extends { id: string }>(agents: readonly T[], items: readonly InboxItem[]): T[] {
    const rank = (agent: T) => {
        const index = items.findIndex((item) => item.agentId === agent.id);
        return index < 0 ? items.length : index;
    };
    return [...agents].sort((a, b) => rank(a) - rank(b));
}

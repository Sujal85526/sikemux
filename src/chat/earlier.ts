import { chatReducer, initialChatState } from "./reducer";
import type { ChatAction, ChatMessage, ChatPart, ChatState } from "./types";

/** How many turns one trip back through a long chat brings from the host. */
export const PAGE_TURNS = 20;

/** A page of turns from before what a remote view holds, as the host sent it. */
export type EarlierPage = { number: number; actions: ChatAction[] };

/**
 * Turns from before what a remote view holds, drawn on their own. A subagent can run on past the
 * page that started it, so what came after the page, `later`, is played on to it too. The ids are
 * renamed so an earlier message can never take the id of one already on screen, which the list
 * keeps its place by.
 */
export function earlierMessages(page: EarlierPage, later: readonly ChatAction[]): ChatMessage[] {
    const own = page.actions.reduce(chatReducer, initialChatState);
    const after = holdsRunningSubagent(own.messages) ? later.reduce(chatReducer, own) : own;
    const ids = new Set(own.messages.map((message) => message.id));
    return after.messages.filter((message) => ids.has(message.id)).map((message) => ({ ...message, id: `earlier-${page.number}-${message.id}` }));
}

/** A subagent drawn where it started takes the place of any card for it shown further down. */
export function withEarlier(state: ChatState, messages: ChatMessage[]): ChatState {
    if (!messages.length) return state;
    const placed = new Set<string>();
    collectSubagents(messages, placed);
    return { ...state, messages: [...messages, ...withoutSubagents(state.messages, placed)], revision: state.revision + 1 };
}

function holdsRunningSubagent(messages: ChatMessage[]): boolean {
    return messages.some((message) =>
        message.parts.some((part) => part.kind === "subagent" && (part.subagent.state === "running" || holdsRunningSubagent(part.subagent.messages))),
    );
}

function collectSubagents(messages: ChatMessage[], into: Set<string>) {
    for (const message of messages)
        for (const part of message.parts) {
            if (part.kind !== "subagent") continue;
            into.add(part.subagent.sessionId);
            collectSubagents(part.subagent.messages, into);
        }
}

function withoutSubagents(messages: ChatMessage[], placed: ReadonlySet<string>): ChatMessage[] {
    if (!placed.size) return messages;
    let changed = false;
    const kept = messages.flatMap((message): ChatMessage[] => {
        const parts = withoutSubagentParts(message.parts, placed);
        if (parts === message.parts) return [message];
        changed = true;
        return parts.length ? [{ ...message, parts }] : [];
    });
    return changed ? kept : messages;
}

function withoutSubagentParts(parts: ChatPart[], placed: ReadonlySet<string>): ChatPart[] {
    let changed = false;
    const kept = parts.flatMap((part): ChatPart[] => {
        if (part.kind !== "subagent") return [part];
        if (placed.has(part.subagent.sessionId)) {
            changed = true;
            return [];
        }
        const messages = withoutSubagents(part.subagent.messages, placed);
        if (messages === part.subagent.messages) return [part];
        changed = true;
        return [{ ...part, subagent: { ...part.subagent, messages } }];
    });
    return changed ? kept : parts;
}

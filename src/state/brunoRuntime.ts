import { create } from "zustand";

/*
 * The parts of a Bruno session that never reach disk: the unsaved text of a
 * request, and the secret environment values typed in this session.
 *
 * They used to live inside `sessions`, so every character typed into a request
 * body wrote to the slice the side rail, the top bar, the lifecycle manager and
 * the persistence loop all watch — and two separate serializers had to
 * remember to strip them again on the way out. Nothing outside the Bruno pane
 * has ever needed to see either one.
 */
interface BrunoRuntimeState {
    /** Unsaved request text, by session and then by file path. */
    drafts: Record<string, Record<string, string>>;
    /** Secret environment values, by session and then by name. */
    secretVars: Record<string, Record<string, string>>;
}

const EMPTY: Record<string, string> = {};

export const useBrunoRuntime = create<BrunoRuntimeState>(() => ({ drafts: {}, secretVars: {} }));

/*
 * A draft is written on every keystroke and read when something is about to act
 * on it, so the writes are coalesced and every read flushes first. The window is
 * short enough that a tab strip's dirty dot still looks immediate.
 */
const DRAFT_WRITE_DELAY_MS = 150;

let pendingDraft: { sessionId: string; path: string; text: string | null } | null = null;
let draftTimer: number | null = null;

function commitDraft({ sessionId, path, text }: { sessionId: string; path: string; text: string | null }): void {
    useBrunoRuntime.setState((state) => {
        const current = state.drafts[sessionId] ?? EMPTY;
        if (text === null) {
            if (!(path in current)) return state;
            const { [path]: _removed, ...rest } = current;
            return { drafts: { ...state.drafts, [sessionId]: rest } };
        }
        if (current[path] === text) return state;
        return { drafts: { ...state.drafts, [sessionId]: { ...current, [path]: text } } };
    });
}

/** Write any draft still waiting on its timer. Safe to call when there is none. */
export function flushBrunoDrafts(): void {
    if (draftTimer !== null) {
        window.clearTimeout(draftTimer);
        draftTimer = null;
    }
    const write = pendingDraft;
    pendingDraft = null;
    if (write) commitDraft(write);
}

/** Stash edited request text by file path; pass null to clear the draft. */
export function setBrunoDraft(sessionId: string, path: string, text: string | null): void {
    if (pendingDraft && (pendingDraft.sessionId !== sessionId || pendingDraft.path !== path)) flushBrunoDrafts();
    pendingDraft = { sessionId, path, text };
    if (draftTimer === null) draftTimer = window.setTimeout(flushBrunoDrafts, DRAFT_WRITE_DELAY_MS);
}

export function brunoDrafts(sessionId: string): Record<string, string> {
    flushBrunoDrafts();
    return useBrunoRuntime.getState().drafts[sessionId] ?? EMPTY;
}

export function setBrunoSecret(sessionId: string, name: string, value: string): void {
    useBrunoRuntime.setState((state) => {
        const current = state.secretVars[sessionId] ?? EMPTY;
        if (current[name] === value) return state;
        return { secretVars: { ...state.secretVars, [sessionId]: { ...current, [name]: value } } };
    });
}

export function forgetBrunoSession(sessionId: string): void {
    if (pendingDraft?.sessionId === sessionId) {
        pendingDraft = null;
        if (draftTimer !== null) {
            window.clearTimeout(draftTimer);
            draftTimer = null;
        }
    }
    useBrunoRuntime.setState((state) => {
        if (!(sessionId in state.drafts) && !(sessionId in state.secretVars)) return state;
        const { [sessionId]: _drafts, ...drafts } = state.drafts;
        const { [sessionId]: _secrets, ...secretVars } = state.secretVars;
        return { drafts, secretVars };
    });
}

export function useBrunoDrafts(sessionId: string): Record<string, string> {
    return useBrunoRuntime((state) => state.drafts[sessionId] ?? EMPTY);
}

export function useBrunoSecretVars(sessionId: string): Record<string, string> {
    return useBrunoRuntime((state) => state.secretVars[sessionId] ?? EMPTY);
}

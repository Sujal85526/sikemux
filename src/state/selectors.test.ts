import { describe, expect, it } from "vitest";
import { getState, setState } from "./store";
import type { StoreState } from "./store";
import {
    selectActiveSession,
    selectActiveWindow,
    selectAgentIds,
    selectItemState,
    selectSession,
    selectSessionIds,
    selectWindowIds,
} from "./selectors";

describe("narrow store selectors", () => {
    it("returns stable entity and index references across unrelated updates", () => {
        const before = getState();
        const sessionId = before.activeSessionId;
        const session = selectSession(sessionId)(before);
        const sessionIds = selectSessionIds(before);
        const windowIds = selectWindowIds(sessionId)(before);
        const agentIds = selectAgentIds(sessionId)(before);

        setState({ commandPaletteOpen: !before.commandPaletteOpen });
        const after = getState();

        expect(selectSession(sessionId)(after)).toBe(session);
        expect(selectSessionIds(after)).toBe(sessionIds);
        expect(selectWindowIds(sessionId)(after)).toBe(windowIds);
        expect(selectAgentIds(sessionId)(after)).toBe(agentIds);
    });

    it("derives the active session and window without projecting whole maps", () => {
        const state = getState();
        expect(selectActiveSession(state)?.id).toBe(state.activeSessionId);
        expect(selectActiveWindow(state)?.id).toBe(state.sessions[state.activeSessionId]?.activeWindowId);
    });

    it("adapts existing item-local state maps by kind", () => {
        const state = getState();
        expect(selectItemState(state, "terminal", "pane")).toBeUndefined();
        expect(selectItemState(state, "aws", "pane")).toBeUndefined();
        expect(selectItemState(state, "editor", "missing")).toBeUndefined();
    });

    /*
     * Bruno keeps its view state per session while the others key by item, so
     * looking it up by pane id silently found nothing.
     */
    it("reads Bruno view state by session rather than by item", () => {
        const view = { openPaths: ["/a.bru"], activeRequestPath: "/a.bru" } as StoreState["brunoViews"][string];
        setState({ brunoViews: { s1: view } });

        expect(selectItemState(getState(), "bruno", "s1")).toBeUndefined();
        expect(selectItemState(getState(), "bruno", "pane", "s1")).toBe(view);
    });
});

import { expect, it, vi } from "vitest";
import { chatReducer, initialChatState } from "./reducer";
import type { ChatState, ToolPart } from "./types";

const update = (state: ChatState, value: Record<string, unknown>) =>
    chatReducer(state, { type: "session_update", sessionId: "session-1", update: value });
const tools = (state: ChatState) => state.messages.flatMap((message) => message.parts).filter((part): part is ToolPart => part.kind === "tool");

it("times a call it watched run", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-18T00:00:00Z"));
    let state = update(initialChatState, { sessionUpdate: "tool_call", toolCallId: "t1", title: "cargo check", status: "pending" });
    vi.setSystemTime(new Date("2026-09-18T00:00:42Z"));
    state = update(state, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" });

    const [part] = tools(state);
    expect((part.endedAt ?? 0) - (part.startedAt ?? 0)).toBe(42_000);
    vi.useRealTimers();
});

it("claims no time for a call that was already over when the session reloaded", () => {
    // A reload replays history at once; timing it here would measure the replay.
    const state = update(initialChatState, { sessionUpdate: "tool_call", toolCallId: "t2", title: "pnpm rust:test", status: "completed" });

    const [part] = tools(state);
    expect(part.startedAt).toBeUndefined();
    expect(part.tool.status).toBe("completed");
});

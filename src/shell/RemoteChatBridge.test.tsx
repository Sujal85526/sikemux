import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AcpChat } from "../api/acp";
import { installIpcTransportForTests, MemoryIpcTransport, resetIpcTransportForTests } from "../api/transport";
import { getState, setState } from "../state/store";
import { FOCUS_AGENT_EVENT, REMOTE_CHAT_BEGUN_EVENT, RemoteChatBridge } from "./RemoteChatBridge";

const initial = getState();
let transport: MemoryIpcTransport;

beforeEach(() => {
    setState(initial, true);
    transport = new MemoryIpcTransport();
    installIpcTransportForTests(transport);
});

afterEach(() => {
    cleanup();
    resetIpcTransportForTests();
});

function phoneChat(): AcpChat {
    return {
        agentId: "agent-from-phone",
        provider: "codex",
        cwd: "/Users/me/site",
        sessionId: null,
        state: "starting",
        running: false,
        pendingPermissions: [],
        startedBy: "phone-key",
        launcher: "codex",
        permissionMode: "workspace-write",
        model: null,
        effort: null,
    };
}

describe("RemoteChatBridge", () => {
    it("adds a chat a phone starts to the host without taking the screen, once", async () => {
        const view = render(<RemoteChatBridge />);
        const before = getState().activeSessionId;
        await act(async () => {
            await Promise.resolve();
        });
        act(() => {
            transport.emit(REMOTE_CHAT_BEGUN_EVENT, phoneChat());
            transport.emit(REMOTE_CHAT_BEGUN_EVENT, phoneChat());
        });
        const state = getState();
        expect(state.agents["agent-from-phone"]).toMatchObject({ type: "codex", cwd: "/Users/me/site", permissionMode: "workspace-write" });
        expect(state.activeSessionId).toBe(before);
        const windows = Object.values(state.windows).filter((window) => window.role === "agent" && window.activePaneId === "agent-from-phone");
        expect(windows).toHaveLength(1);
        view.unmount();
        expect(transport.eventListenerCount).toBe(0);
    });

    it("shows the agent the notch asks for, switching project on the way", async () => {
        render(<RemoteChatBridge />);
        await act(async () => {
            await Promise.resolve();
        });
        act(() => {
            transport.emit(REMOTE_CHAT_BEGUN_EVENT, phoneChat());
        });
        expect(getState().sessions[getState().activeSessionId]?.cwd).not.toBe("/Users/me/site");
        act(() => {
            transport.emit(FOCUS_AGENT_EVENT, "agent-from-phone");
        });
        const state = getState();
        const session = state.sessions[state.activeSessionId];
        expect(session?.cwd).toBe("/Users/me/site");
        expect(state.windows[session?.activeWindowId ?? ""]?.activePaneId).toBe("agent-from-phone");
    });
});

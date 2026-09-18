import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Agent, Session } from "../state/types";
import { AgentSurface } from "./AgentSurface";

const mocks = vi.hoisted(() => ({ chatPane: vi.fn(() => null) }));

vi.mock("./AgentChatPane", () => ({ AgentChatPane: mocks.chatPane }));
vi.mock("../terminal/TerminalPane", () => ({ TerminalPane: () => null }));
vi.mock("../state/store", () => ({ useStore: () => ({}) }));
vi.mock("../state/commands", () => ({
    newBrowserTab: vi.fn(),
    toggleAgentSkipPermissions: vi.fn(),
    agentSupportsSkipPermissions: () => true,
}));

const agent: Agent = {
    id: "agent-1",
    type: "claude",
    title: "Agent session",
    startup: "claude",
    permissionMode: "workspace-write",
    launchState: "live",
};

const session: Session = { id: "session-1", name: "repo", kind: "project", cwd: "/repo", pinned: false, activeWindowId: "window-1" };

afterEach(() => {
    cleanup();
    mocks.chatPane.mockClear();
});

/* The window layer keeps a live agent mounted so it keeps its process. The
   adapter and CLI take about a second to come up, so that has to start with the
   pane, not with the first look at it. */
it("connects an agent that is mounted but not on screen", () => {
    render(<AgentSurface agent={agent} session={session} visible={false} />);
    expect(mocks.chatPane).toHaveBeenCalledWith(expect.objectContaining({ active: true, visible: false }), undefined);
});

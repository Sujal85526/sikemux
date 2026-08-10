import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    available: vi.fn(),
    sessions: vi.fn(),
}));

vi.mock("../api/agents", () => ({
    agentApi: { available: mocks.available, sessions: mocks.sessions },
}));

// jsdom has no ResizeObserver; the rail uses one to keep filling its list.
vi.stubGlobal(
    "ResizeObserver",
    class {
        observe() {}
        disconnect() {}
    },
);

import { invalidate } from "../state/resources";
import { getState, setState } from "../state/store";
import { AgentRail } from "./AgentRail";

const initial = getState();

beforeEach(() => {
    setState(initial, true);
    setState({
        sessions: {
            "sess-project": {
                id: "sess-project",
                name: "sikemux",
                kind: "project" as const,
                cwd: "/code/sikemux",
                deploy: null,
                pinned: false,
                activeWindowId: "win-project",
                activeAgentId: null,
                view: "agent" as const,
            },
        },
        sessionOrder: ["sess-project"],
        activeSessionId: "sess-project",
        agents: {},
        agentsBySession: { "sess-project": [] },
    });
    mocks.available.mockResolvedValue([{ type: "codex", label: "Codex", command: "codex" }]);
    mocks.sessions.mockResolvedValue([
        { id: "older", title: "Fix terminal focus", mtime: 100 },
        { id: "newer", title: "Build launch page", mtime: 200 },
    ]);
    invalidate((kind) => kind === "agents.catalog" || kind === "agents.sessions");
});

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

describe("agent rail", () => {
    it("owns recent chats and filters them in place", async () => {
        const user = userEvent.setup();
        render(<AgentRail />);

        expect(await screen.findByRole("button", { name: /Fix terminal focus/ })).toBeInTheDocument();

        await user.click(screen.getByTitle("Filter recent chats"));
        await user.type(screen.getByRole("textbox", { name: "Filter recent chats" }), "terminal");

        expect(screen.getByRole("button", { name: /Fix terminal focus/ })).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /Build launch page/ })).not.toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: /Fix terminal focus/ }));
        await waitFor(() => expect(getState().agentsBySession["sess-project"]).toHaveLength(1));
        const agent = getState().agents[getState().agentsBySession["sess-project"][0]];
        expect(agent).toMatchObject({ resumeId: "older", title: "Fix terminal focus", cwd: "/code/sikemux" });
    });

    it("shows the open new-agent draft as the selected lane", async () => {
        render(<AgentRail />);
        await screen.findByRole("button", { name: /Fix terminal focus/ });
        expect(screen.queryByText("Drafting")).not.toBeInTheDocument();

        setState({ agentPaletteOpen: true });

        expect(await screen.findByText("Drafting")).toBeInTheDocument();
        await userEvent.setup().click(screen.getByRole("button", { name: "Close new agent" }));
        expect(getState().agentPaletteOpen).toBe(false);
    });
});

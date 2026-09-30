import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    available: vi.fn(),
    sessions: vi.fn(),
    usage: vi.fn(),
    renameSession: vi.fn(() => Promise.resolve()),
}));

vi.mock("../api/agents", () => ({
    agentApi: { available: mocks.available, sessions: mocks.sessions, usage: mocks.usage, renameSession: mocks.renameSession },
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
import { AgentRailBody } from "./AgentRail";
import { agentIdsOf } from "../state/selectors";
import { withAgents } from "../test/agents";

function openAgent(title: string) {
    setState((state) =>
        withAgents(state, "sess-project", [{ id: "agent-open", type: "codex", title, startup: "codex", cwd: "/code/sikemux", launchState: "live" }]),
    );
}

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
                pinned: false,
                activeWindowId: "win-project",
            },
        },
        sessionOrder: ["sess-project"],
        activeSessionId: "sess-project",
        agents: {},
    });
    mocks.available.mockResolvedValue([{ type: "codex", label: "Codex", command: "codex", defaultModel: "gpt-5.6-sol", defaultEffort: "high" }]);
    mocks.sessions.mockResolvedValue([
        { id: "older", title: "Fix terminal focus", mtime: 100 },
        { id: "newer", title: "Build launch page", mtime: 200 },
    ]);
    mocks.usage.mockResolvedValue({
        provider: "codex",
        plan: "pro",
        windows: [
            { label: "5h", usedPercent: 37, resetsAt: Math.floor(Date.now() / 1000) + 90 * 60, windowMinutes: 300 },
            { label: "7d", usedPercent: 12, resetsAt: Math.floor(Date.now() / 1000) + 4 * 86_400, windowMinutes: 10_080 },
        ],
    });
    invalidate((kind) => kind === "agents.catalog" || kind === "agents.sessions" || kind === "agents.usage");
});

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

describe("agent rail", () => {
    it("owns recent chats and filters them in place", async () => {
        const user = userEvent.setup();
        render(<AgentRailBody />);

        expect(await screen.findByRole("button", { name: /Fix terminal focus/ })).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Filter recent chats" }));
        await user.type(screen.getByRole("textbox", { name: "Filter recent chats" }), "terminal");

        expect(screen.getByRole("button", { name: /Fix terminal focus/ })).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /Build launch page/ })).not.toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: /Fix terminal focus/ }));
        await waitFor(() => expect(agentIdsOf(getState(), "sess-project")).toHaveLength(1));
        const agent = getState().agents[agentIdsOf(getState(), "sess-project")[0]];
        expect(agent).toMatchObject({ resumeId: "older", title: "Fix terminal focus", cwd: "/code/sikemux" });
    });

    it("starts a fresh chat for the selected provider from the new chat row", async () => {
        const user = userEvent.setup();
        render(<AgentRailBody />);

        await user.click(await screen.findByRole("button", { name: "New chat" }));
        await waitFor(() => expect(agentIdsOf(getState(), "sess-project")).toHaveLength(1));
        const agent = getState().agents[agentIdsOf(getState(), "sess-project")[0]];
        expect(agent).toMatchObject({ type: "codex", cwd: "/code/sikemux" });
        expect(agent.resumeId).toBeUndefined();
    });

    it("shows live plan windows only for detected Codex and Claude providers", async () => {
        const resetBase = Math.floor(Date.now() / 1000);
        mocks.available.mockResolvedValue([
            { type: "codex", label: "Codex", command: "codex", defaultModel: null, defaultEffort: null },
            { type: "claude", label: "Claude", command: "claude", defaultModel: null, defaultEffort: null },
        ]);
        mocks.usage.mockImplementation(async (provider: "codex" | "claude") =>
            provider === "codex"
                ? {
                      provider,
                      plan: "pro",
                      windows: [{ label: "5h", usedPercent: 37, resetsAt: resetBase + 90 * 60, windowMinutes: 300 }],
                  }
                : {
                      provider,
                      plan: "max",
                      windows: [{ label: "7d", usedPercent: 82, resetsAt: "2026-08-20T00:00:00Z", windowMinutes: 10_080 }],
                  },
        );
        invalidate((kind) => kind === "agents.catalog" || kind === "agents.usage");

        const user = userEvent.setup();
        render(<AgentRailBody />);

        expect(await screen.findByRole("region", { name: "Codex plan limits" })).toBeInTheDocument();
        expect(await screen.findByRole("meter", { name: "5h usage" })).toHaveAttribute("aria-valuenow", "37");
        expect(screen.getByText("reset 1h 30m")).toBeInTheDocument();

        await user.click(screen.getByRole("tab", { name: "Claude" }));
        expect(await screen.findByRole("region", { name: "Claude plan limits" })).toBeInTheDocument();
        expect(await screen.findByRole("meter", { name: "7d usage" })).toHaveAttribute("aria-valuenow", "82");
        expect(mocks.usage).toHaveBeenCalledWith("codex", "codex", undefined);
        expect(mocks.usage).toHaveBeenCalledWith("claude", "claude", undefined);
    });

    it("explains unavailable subscription limits without rendering a zero meter", async () => {
        mocks.usage.mockResolvedValue({
            provider: "codex",
            plan: null,
            windows: [],
            unavailableReason: "API-key accounts do not provide plan usage.",
        });
        invalidate((kind) => kind === "agents.catalog" || kind === "agents.usage");

        render(<AgentRailBody />);

        expect(await screen.findByText("API-key accounts do not provide plan usage.")).toBeInTheDocument();
        expect(screen.queryByRole("meter")).not.toBeInTheDocument();
    });

    it("does not request or render plan usage for other detected agents", async () => {
        mocks.available.mockResolvedValue([{ type: "hermes", label: "Hermes", command: "hermes", defaultModel: null, defaultEffort: null }]);
        invalidate((kind) => kind === "agents.catalog" || kind === "agents.usage");

        render(<AgentRailBody />);

        expect(await screen.findByRole("tab", { name: "Hermes" })).toBeInTheDocument();
        expect(screen.queryByRole("region", { name: /plan limits/i })).not.toBeInTheDocument();
        expect(mocks.usage).not.toHaveBeenCalled();
    });

    it("renames an open chat in place on double-click", async () => {
        openAgent("Fix terminal focus");
        const user = userEvent.setup();
        render(<AgentRailBody />);

        await user.dblClick(await screen.findByRole("button", { name: "Fix terminal focus" }));
        const field = screen.getByRole("textbox", { name: "Chat name" });
        await user.clear(field);
        await user.type(field, "Terminal focus bug{Enter}");

        expect(getState().agents["agent-open"]).toMatchObject({ title: "Terminal focus bug", renamed: true });
        expect(screen.getByRole("button", { name: "Terminal focus bug" })).toBeInTheDocument();
    });

    it("keeps the old name when a rename is cancelled with Escape", async () => {
        openAgent("Fix terminal focus");
        const user = userEvent.setup();
        render(<AgentRailBody />);

        await user.dblClick(await screen.findByRole("button", { name: "Fix terminal focus" }));
        await user.type(screen.getByRole("textbox", { name: "Chat name" }), " draft{Escape}");

        expect(getState().agents["agent-open"].title).toBe("Fix terminal focus");
        expect(screen.queryByRole("textbox", { name: "Chat name" })).not.toBeInTheDocument();
    });

    it("opens the agent menu on right-click and renames from it", async () => {
        openAgent("Fix terminal focus");
        const user = userEvent.setup();
        render(<AgentRailBody />);

        await user.pointer({ keys: "[MouseRight]", target: await screen.findByRole("button", { name: "Fix terminal focus" }) });
        expect(screen.getByRole("menuitem", { name: /Close Others/ })).toBeInTheDocument();
        expect(screen.getByRole("menuitem", { name: /Copy Link/ })).toBeInTheDocument();

        await user.click(screen.getByRole("menuitem", { name: "Rename…" }));
        expect(screen.getByRole("textbox", { name: "Chat name" })).toHaveValue("Fix terminal focus");
    });

    it("renames a recent chat in the provider's own session from the row's menu", async () => {
        mocks.available.mockResolvedValue([{ type: "claude", label: "Claude", command: "claude", defaultModel: null, defaultEffort: null }]);
        invalidate((kind) => kind === "agents.catalog");
        const user = userEvent.setup();
        render(<AgentRailBody />);

        await user.pointer({ keys: "[MouseRight]", target: await screen.findByRole("button", { name: /Fix terminal focus/ }) });
        await user.click(screen.getByRole("menuitem", { name: "Rename…" }));
        const field = screen.getByRole("textbox", { name: "Chat name" });
        await user.clear(field);
        await user.type(field, "Terminal focus bug{Enter}");

        expect(mocks.renameSession).toHaveBeenCalledWith("claude", "/code/sikemux", "older", "Terminal focus bug", "claude", undefined);
        expect(agentIdsOf(getState(), "sess-project")).toHaveLength(0);
    });

    it("opens a recent chat from the row's menu", async () => {
        const user = userEvent.setup();
        render(<AgentRailBody />);

        await user.pointer({ keys: "[MouseRight]", target: await screen.findByRole("button", { name: /Fix terminal focus/ }) });
        expect(screen.getByRole("menuitem", { name: "Rename…" })).toBeInTheDocument();

        await user.click(screen.getByRole("menuitem", { name: "Open" }));
        await waitFor(() => expect(agentIdsOf(getState(), "sess-project")).toHaveLength(1));
    });
});

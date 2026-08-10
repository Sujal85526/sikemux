import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    available: vi.fn(),
    models: vi.fn(),
    sessions: vi.fn(),
    sessionResults: vi.fn(),
    worktrees: vi.fn(),
    invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

vi.mock("../api/agents", () => ({
    agentApi: {
        available: mocks.available,
        models: mocks.models,
        sessions: mocks.sessions,
        sessionResults: mocks.sessionResults,
    },
}));

vi.mock("../api/git", () => ({
    git: {
        worktrees: mocks.worktrees,
    },
}));

import { invalidate } from "../state/resources";
import { getState, setState } from "../state/store";
import { AgentPalette } from "./AgentPalette";

const initial = getState();

/**
 * Open one of the composer bar's dropdowns and choose an option by label. An
 * option's accessible name also carries its detail line, so a string matches on
 * the leading label rather than the whole name.
 */
async function pickOption(user: ReturnType<typeof userEvent.setup>, control: string, option: string | RegExp) {
    const name = typeof option === "string" ? new RegExp(`^${option.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) : option;
    await user.click(screen.getByRole("button", { name: control }));
    const menu = screen.getByRole("listbox", { name: control });
    await user.click(within(menu).getByRole("option", { name }));
}

beforeEach(() => {
    setState(initial, true);
    const project = {
        id: "sess-project",
        name: "sikemux",
        kind: "project" as const,
        cwd: "/code/sikemux",
        deploy: null,
        pinned: false,
        activeWindowId: "win-project",
        activeAgentId: null,
        view: "windows" as const,
    };
    setState({
        sessions: { [project.id]: project },
        sessionOrder: [project.id],
        activeSessionId: project.id,
        agents: {},
        agentsBySession: { [project.id]: [] },
        agentPaletteOpen: true,
    });
    mocks.available.mockResolvedValue([{ type: "codex", label: "Codex", command: "codex", defaultModel: "gpt-5.6-sol", defaultEffort: "high" }]);
    mocks.models.mockResolvedValue([
        { id: "gpt-5.6-sol", label: "GPT-5.6-Sol" },
        { id: "gpt-5.6-terra", label: "GPT-5.6-Terra" },
        { id: "gpt-5.5", label: "GPT-5.5" },
    ]);
    mocks.sessions.mockResolvedValue([]);
    mocks.worktrees.mockResolvedValue([
        {
            path: "/code/sikemux",
            head: "abc",
            branch: "main",
            reference: "refs/heads/main",
            detached: false,
            locked: false,
            lock_reason: null,
            prunable: false,
            prune_reason: null,
            bare: false,
            current: true,
            is_main: true,
        },
        {
            path: "/code/sikemux-review",
            head: "def",
            branch: "review/ui",
            reference: "refs/heads/review/ui",
            detached: false,
            locked: false,
            lock_reason: null,
            prunable: false,
            prune_reason: null,
            bare: false,
            current: false,
            is_main: false,
        },
    ]);
    mocks.invoke.mockResolvedValue({ code: 0, output: "ready" });
    invalidate((kind) => kind === "agents.catalog" || kind === "agents.models" || kind === "agents.sessions");
});

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

describe("AgentPalette new agent page", () => {
    it("focuses the composer and restores the opener without trapping focus", async () => {
        const opener = document.createElement("button");
        document.body.append(opener);
        opener.focus();
        const view = render(<AgentPalette />);

        await waitFor(() => expect(screen.getByRole("textbox", { name: "Task for the new agent" })).toHaveFocus());
        // The page is a pane, not a modal — no focus trap holds Tab inside it.
        expect(screen.getByRole("region", { name: "New agent" })).not.toHaveAttribute("aria-modal");

        view.unmount();
        expect(opener).toHaveFocus();
        opener.remove();
    });

    it("keeps every launch choice in one compact bar with no chat history of its own", async () => {
        render(<AgentPalette />);

        expect(await screen.findByRole("region", { name: "New agent" })).toHaveClass("new-agent-page");
        // Every control is the app's own dropdown — no native <select> anywhere.
        expect(await screen.findByRole("button", { name: "Agent" })).toHaveTextContent("Codex");
        expect(screen.getByRole("button", { name: "Workspace" })).toHaveTextContent("Current checkout");
        expect(screen.getByRole("button", { name: "Safety" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("GPT-5.6-Sol");
        expect(screen.getByRole("button", { name: "Effort" })).toHaveTextContent("high");
        expect(document.querySelectorAll("select")).toHaveLength(0);
        // Recent chats belong to the agent rail; the page never duplicates them.
        expect(screen.queryByRole("complementary", { name: "Recent chats" })).not.toBeInTheDocument();
        expect(screen.queryByRole("textbox", { name: /search/i })).not.toBeInTheDocument();
    });

    it("shows display names while preserving the CLI's full model ids", async () => {
        const user = userEvent.setup();
        render(<AgentPalette />);
        await screen.findByRole("button", { name: "Agent" });

        await user.click(screen.getByRole("button", { name: "Model" }));
        const menu = screen.getByRole("listbox", { name: "Model" });
        expect(within(menu).getByRole("option", { name: /GPT-5\.6-Sol.*gpt-5\.6-sol.*CLI default/ })).toBeInTheDocument();
        expect(await within(menu).findByRole("option", { name: /GPT-5\.6-Terra.*gpt-5\.6-terra/ })).toBeInTheDocument();
        expect(within(menu).getByRole("option", { name: /GPT-5\.5.*gpt-5\.5/ })).toBeInTheDocument();
        expect(within(menu).queryByRole("option", { name: /alias/i })).not.toBeInTheDocument();

        await user.click(within(menu).getByRole("option", { name: /Custom/ }));
        const field = screen.getByRole("textbox", { name: "Model" });
        await user.type(field, "gpt-6-experimental");
        expect(field).toHaveValue("gpt-6-experimental");
    });

    it("shows the CLI effort default without turning it into a launch override", async () => {
        const user = userEvent.setup();
        render(<AgentPalette />);
        await screen.findByRole("button", { name: "Agent" });

        await user.click(screen.getByRole("button", { name: "Effort" }));
        const menu = screen.getByRole("listbox", { name: "Effort" });
        expect(within(menu).getByRole("option", { name: /high.*CLI default/ })).toBeInTheDocument();
        expect(within(menu).getByRole("option", { name: "xhigh" })).toBeInTheDocument();
        await user.keyboard("{Escape}");

        await user.type(screen.getByRole("textbox", { name: "Task for the new agent" }), "Inherit the configured effort.");
        await user.click(screen.getByRole("button", { name: /Start task/ }));

        await waitFor(() => expect(getState().agentsBySession["sess-project"]).toHaveLength(1));
        const agent = getState().agents[getState().agentsBySession["sess-project"][0]];
        expect(agent.effort).toBeUndefined();
    });

    it("keeps full Codex choices when the live CLI catalog is empty", async () => {
        const user = userEvent.setup();
        mocks.models.mockResolvedValueOnce([]);
        invalidate((kind) => kind === "agents.models");
        render(<AgentPalette />);

        await user.click(await screen.findByRole("button", { name: "Model" }));
        const menu = screen.getByRole("listbox", { name: "Model" });
        expect(within(menu).getByRole("option", { name: /gpt-5\.6-terra/ })).toBeInTheDocument();
        expect(within(menu).getByRole("option", { name: /gpt-5\.6-luna/ })).toBeInTheDocument();
        expect(within(menu).getByRole("option", { name: /gpt-5\.5/ })).toBeInTheDocument();
        expect(within(menu).getByRole("option", { name: /gpt-5\.2/ })).toBeInTheDocument();
        expect(screen.getByText(/returned no models; showing bundled full model IDs/i)).toBeInTheDocument();
    });

    it("keeps full Codex choices and exposes a failed live lookup", async () => {
        const user = userEvent.setup();
        mocks.models.mockRejectedValueOnce(new Error("Codex lookup failed"));
        invalidate((kind) => kind === "agents.models");
        render(<AgentPalette />);

        await user.click(await screen.findByRole("button", { name: "Model" }));
        const menu = screen.getByRole("listbox", { name: "Model" });
        expect(within(menu).getByRole("option", { name: /gpt-5\.6-terra/ })).toBeInTheDocument();
        expect(within(menu).getByRole("option", { name: /gpt-5\.6-luna/ })).toBeInTheDocument();
        expect(within(menu).getByRole("option", { name: /Custom.*CLI lookup failed/i })).toBeInTheDocument();
        expect(screen.getByText(/model lookup failed; showing bundled full model IDs/i)).toBeInTheDocument();
    });

    it("launches a prompted agent from the recommended current checkout", async () => {
        const user = userEvent.setup();
        render(<AgentPalette />);
        await screen.findByRole("button", { name: "Agent" });

        await user.type(screen.getByRole("textbox", { name: "Task for the new agent" }), "Polish the launch experience and test it.");
        await pickOption(user, "Model", "GPT-5.5");
        await pickOption(user, "Effort", "xhigh");
        await pickOption(user, "Safety", "Observe");
        await user.click(screen.getByRole("button", { name: /Start task/ }));

        await waitFor(() => expect(getState().agentsBySession["sess-project"]).toHaveLength(1));
        const agent = getState().agents[getState().agentsBySession["sess-project"][0]];
        expect(agent).toMatchObject({
            type: "codex",
            cwd: "/code/sikemux",
            permissionMode: "read-only",
            model: "gpt-5.5",
            effort: "xhigh",
            workspaceStrategy: "current",
        });
        expect(agent.startup).toContain("Polish the launch experience and test it.");
    });

    it("uses an existing worktree without exposing branch or path creation fields", async () => {
        const user = userEvent.setup();
        render(<AgentPalette />);
        await screen.findByRole("button", { name: "Agent" });

        await pickOption(user, "Workspace", "Existing worktree");
        const chooser = await screen.findByRole("button", { name: "Worktree" });
        await waitFor(() => expect(chooser).toBeEnabled());
        await pickOption(user, "Worktree", "review/ui");
        expect(screen.queryByRole("textbox", { name: /branch/i })).not.toBeInTheDocument();
        expect(screen.queryByRole("textbox", { name: /path/i })).not.toBeInTheDocument();

        await user.type(screen.getByRole("textbox", { name: "Task for the new agent" }), "Review this isolated lane.");
        await user.click(screen.getByRole("button", { name: /Start task/ }));

        await waitFor(() => expect(getState().agentsBySession["sess-project"]).toHaveLength(1));
        const agent = getState().agents[getState().agentsBySession["sess-project"][0]];
        expect(agent).toMatchObject({ cwd: "/code/sikemux-review", workspaceStrategy: "existing" });
    });

    it("offers lazy agent-decided isolation with no eager worktree lookup", async () => {
        const user = userEvent.setup();
        render(<AgentPalette />);
        await screen.findByRole("button", { name: "Agent" });

        await pickOption(user, "Workspace", "Agent decides");
        expect(screen.queryByRole("button", { name: "Worktree" })).not.toBeInTheDocument();
        expect(mocks.worktrees).not.toHaveBeenCalled();

        await user.type(screen.getByRole("textbox", { name: "Task for the new agent" }), "Handle isolation only if it becomes necessary.");
        await user.click(screen.getByRole("button", { name: /Start task/ }));

        await waitFor(() => expect(getState().agentsBySession["sess-project"]).toHaveLength(1));
        const agent = getState().agents[getState().agentsBySession["sess-project"][0]];
        expect(agent).toMatchObject({ cwd: "/code/sikemux", workspaceStrategy: "agent-decides" });
    });

    it("reports CLI detection state and retries a failed detection", async () => {
        const user = userEvent.setup();
        mocks.available
            .mockRejectedValueOnce(new Error("missing PATH"))
            .mockResolvedValueOnce([{ type: "codex", label: "Codex", command: "codex", defaultModel: "gpt-5.6-sol", defaultEffort: "high" }]);
        invalidate((kind) => kind === "agents.catalog");
        render(<AgentPalette />);

        expect(await screen.findByText(/missing PATH/)).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Try again" }));

        expect(await screen.findByRole("button", { name: "Agent" })).toHaveTextContent("Codex");
        expect(mocks.available).toHaveBeenCalledTimes(2);
    });

    it("launches on Enter, preserves Shift-Enter newlines, and guards keyboard re-entry", async () => {
        const user = userEvent.setup();
        render(<AgentPalette />);
        await screen.findByRole("region", { name: "New agent" });
        const composer = screen.getByRole("textbox", { name: "Task for the new agent" });
        await user.type(composer, "Launch exactly once.");
        await user.keyboard("{Shift>}{Enter}{/Shift}With a second line.");
        expect(composer).toHaveValue("Launch exactly once.\nWith a second line.");
        expect(screen.getByRole("button", { name: /Start task/ })).toHaveAttribute("aria-keyshortcuts", "Enter");

        fireEvent.keyDown(composer, { key: "Enter" });
        fireEvent.keyDown(composer, { key: "Enter" });
        await waitFor(() => expect(getState().agentsBySession["sess-project"]).toHaveLength(1));
        const agent = getState().agents[getState().agentsBySession["sess-project"][0]];
        expect(agent.startup).toContain("Launch exactly once.\nWith a second line.");
        // Attaching the agent retires the draft tab it was launched from.
        expect(getState().agentPaletteOpen).toBe(false);

        setState({ agentPaletteOpen: true });
        cleanup();
        render(<AgentPalette />);
        fireEvent.keyDown(screen.getByRole("region", { name: "New agent" }), { key: "Escape" });
        expect(getState().agentPaletteOpen).toBe(false);
    });

    it("does not launch when Enter activates another control", async () => {
        const user = userEvent.setup();
        render(<AgentPalette />);
        const model = await screen.findByRole("button", { name: "Model" });
        await user.type(screen.getByRole("textbox", { name: "Task for the new agent" }), "Keep controls keyboard-safe.");

        fireEvent.keyDown(model, { key: "Enter" });

        expect(getState().agentsBySession["sess-project"]).toHaveLength(0);
        expect(getState().agentPaletteOpen).toBe(true);
    });
});

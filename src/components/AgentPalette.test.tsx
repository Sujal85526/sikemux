import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    available: vi.fn(),
    sessions: vi.fn(),
    sessionResults: vi.fn(),
    worktrees: vi.fn(),
    invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

vi.mock("../api/agents", () => ({
    agentApi: {
        available: mocks.available,
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
    mocks.available.mockResolvedValue([{ type: "codex", label: "Codex", command: "codex" }]);
    mocks.sessions.mockResolvedValue([]);
    mocks.sessionResults.mockImplementation(async (providers: Array<{ type: string }>, cwd: string) =>
        Promise.all(
            providers.map(async (provider) => ({
                provider,
                status: "success" as const,
                sessions: await mocks.sessions(provider.type, cwd),
            })),
        ),
    );
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
    invalidate((kind) => kind === "agents.catalog" || kind === "agents.sessions");
});

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

describe("AgentPalette new agent page", () => {
    it("keeps focus inside the page, restores the opener, and supports radio arrow keys", async () => {
        const opener = document.createElement("button");
        document.body.append(opener);
        opener.focus();
        const view = render(<AgentPalette />);

        const current = await screen.findByRole("radio", { name: /Current checkout/ });
        current.focus();
        fireEvent.keyDown(current, { key: "ArrowRight" });
        await waitFor(() => expect(screen.getByRole("radio", { name: /Agent decides/ })).toHaveAttribute("aria-checked", "true"));

        const page = screen.getByRole("dialog", { name: "New agent" });
        const close = screen.getByRole("button", { name: "Close new agent" });
        close.focus();
        fireEvent.keyDown(page, { key: "Tab", shiftKey: true });
        expect(page).toContainElement(document.activeElement as HTMLElement);

        view.unmount();
        expect(opener).toHaveFocus();
        opener.remove();
    });

    it("launches a prompted agent from the recommended current checkout", async () => {
        const user = userEvent.setup();
        render(<AgentPalette />);

        expect(await screen.findByRole("dialog", { name: "New agent" })).toHaveClass("new-agent-page");
        expect(await screen.findByRole("radio", { name: /Codex/ })).toHaveAttribute("aria-checked", "true");
        expect(screen.getByRole("radio", { name: /Current checkout/ })).toHaveAttribute("aria-checked", "true");

        await user.type(screen.getByRole("textbox", { name: "Task for the new agent" }), "Polish the launch experience and test it.");
        await user.type(screen.getByRole("combobox", { name: "Model" }), "gpt-5.6");
        await user.click(screen.getByRole("radio", { name: "xhigh" }));
        await user.click(screen.getByRole("radio", { name: /Observe/ }));
        await user.click(screen.getByRole("button", { name: /Start task/ }));

        await waitFor(() => expect(getState().agentsBySession["sess-project"]).toHaveLength(1));
        const agent = getState().agents[getState().agentsBySession["sess-project"][0]];
        expect(agent).toMatchObject({
            type: "codex",
            cwd: "/code/sikemux",
            permissionMode: "read-only",
            model: "gpt-5.6",
            effort: "xhigh",
            workspaceStrategy: "current",
        });
        expect(agent.startup).toContain("Polish the launch experience and test it.");
    });

    it("uses an existing worktree without exposing branch or path creation fields", async () => {
        const user = userEvent.setup();
        render(<AgentPalette />);
        await screen.findByRole("radio", { name: /Codex/ });

        await user.click(screen.getByRole("radio", { name: /Existing worktree/ }));
        const chooser = await screen.findByRole("combobox", { name: "Worktree" });
        await user.selectOptions(chooser, "/code/sikemux-review");
        expect(screen.queryByRole("textbox", { name: /branch/i })).not.toBeInTheDocument();
        expect(screen.queryByRole("textbox", { name: /path/i })).not.toBeInTheDocument();

        await user.type(screen.getByRole("textbox", { name: "Task for the new agent" }), "Review this isolated lane.");
        await user.click(screen.getByRole("button", { name: /Start task/ }));

        await waitFor(() => expect(getState().agentsBySession["sess-project"]).toHaveLength(1));
        const agent = getState().agents[getState().agentsBySession["sess-project"][0]];
        expect(agent).toMatchObject({ cwd: "/code/sikemux-review", workspaceStrategy: "existing" });
    });

    it("offers lazy agent-decided isolation with no eager worktree form", async () => {
        const user = userEvent.setup();
        render(<AgentPalette />);
        await screen.findByRole("radio", { name: /Codex/ });

        await user.click(screen.getByRole("radio", { name: /Agent decides/ }));
        expect(screen.queryByRole("textbox", { name: /branch/i })).not.toBeInTheDocument();
        expect(screen.queryByRole("textbox", { name: /path/i })).not.toBeInTheDocument();
        await user.type(screen.getByRole("textbox", { name: "Task for the new agent" }), "Handle isolation only if it becomes necessary.");
        await user.click(screen.getByRole("button", { name: /Start task/ }));

        await waitFor(() => expect(getState().agentsBySession["sess-project"]).toHaveLength(1));
        const agent = getState().agents[getState().agentsBySession["sess-project"][0]];
        expect(agent).toMatchObject({ cwd: "/code/sikemux", workspaceStrategy: "agent-decides" });
    });

    it("shows detection, history loading, empty, and history error states", async () => {
        const provider = { type: "codex" as const, label: "Codex", command: "codex" };
        let resolveCatalog!: (value: Array<{ type: "codex"; label: string; command: string }>) => void;
        let resolveHistory!: (value: Array<{ provider: typeof provider; status: "success"; sessions: [] }>) => void;
        mocks.available.mockReturnValueOnce(
            new Promise((resolve) => {
                resolveCatalog = resolve;
            }),
        );
        mocks.sessionResults.mockReturnValueOnce(
            new Promise((resolve) => {
                resolveHistory = resolve;
            }),
        );
        render(<AgentPalette />);
        expect(screen.getByText("Detecting agent CLIs…")).toBeInTheDocument();
        resolveCatalog([provider]);
        expect(await screen.findByText("Loading chat history…")).toBeInTheDocument();
        resolveHistory([{ provider, status: "success", sessions: [] }]);
        expect(await screen.findByText("No recent chats in this project.")).toBeInTheDocument();

        cleanup();
        mocks.sessionResults.mockImplementation(async (providers: Array<{ type: string }>) =>
            providers.map((provider) => ({ provider, status: "error" as const, sessions: [] })),
        );
        invalidate((kind) => kind === "agents.catalog" || kind === "agents.sessions");
        render(<AgentPalette />);
        expect(await screen.findByRole("alert")).toHaveTextContent("Recent chats could not be loaded.");
    });

    it("retries failed CLI detection instead of replaying the same error state", async () => {
        const user = userEvent.setup();
        mocks.available.mockRejectedValueOnce(new Error("missing PATH")).mockResolvedValueOnce([{ type: "codex", label: "Codex", command: "codex" }]);
        invalidate((kind) => kind === "agents.catalog");
        render(<AgentPalette />);

        expect((await screen.findAllByText("missing PATH")).length).toBeGreaterThan(0);
        await user.click(screen.getByRole("button", { name: "Try again" }));

        expect(await screen.findByRole("radio", { name: /Codex/ })).toHaveAttribute("aria-checked", "true");
        expect(mocks.available).toHaveBeenCalledTimes(2);
    });

    it("searches and resumes recent chats from the same page", async () => {
        const user = userEvent.setup();
        mocks.sessions.mockImplementation(async (_provider: string, cwd: string) =>
            cwd === "/code/sikemux"
                ? [
                      { id: "older", title: "Fix terminal focus", mtime: 100 },
                      { id: "newer", title: "Build launch page", mtime: 200 },
                  ]
                : [],
        );
        render(<AgentPalette />);

        const history = await screen.findByRole("complementary", { name: "Recent chats" });
        await user.type(within(history).getByRole("textbox", { name: "Search recent chats" }), "terminal");
        expect(within(history).getByRole("button", { name: /Fix terminal focus/ })).toBeInTheDocument();
        expect(within(history).queryByRole("button", { name: /Build launch page/ })).not.toBeInTheDocument();
        await user.click(within(history).getByRole("button", { name: /Fix terminal focus/ }));

        await waitFor(() => expect(getState().agentsBySession["sess-project"]).toHaveLength(1));
        const agent = getState().agents[getState().agentsBySession["sess-project"][0]];
        expect(agent).toMatchObject({ resumeId: "older", title: "Fix terminal focus", cwd: "/code/sikemux" });
    });

    it("closes on Escape and guards keyboard launch against re-entry", async () => {
        const user = userEvent.setup();
        render(<AgentPalette />);
        const dialog = await screen.findByRole("dialog", { name: "New agent" });
        await user.type(screen.getByRole("textbox", { name: "Task for the new agent" }), "Launch exactly once.");

        fireEvent.keyDown(dialog, { key: "Enter", metaKey: true });
        fireEvent.keyDown(dialog, { key: "Enter", metaKey: true });
        await waitFor(() => expect(getState().agentsBySession["sess-project"]).toHaveLength(1));

        setState({ agentPaletteOpen: true });
        cleanup();
        render(<AgentPalette />);
        fireEvent.keyDown(screen.getByRole("dialog", { name: "New agent" }), { key: "Escape" });
        expect(getState().agentPaletteOpen).toBe(false);
    });
});

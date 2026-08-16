import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    available: vi.fn(),
    invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../api/agents", () => ({
    agentApi: {
        available: mocks.available,
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
        view: "agent" as const,
    };
    setState({
        sessions: { [project.id]: project },
        sessionOrder: [project.id],
        activeSessionId: project.id,
        agents: {},
        agentsBySession: { [project.id]: [] },
        agentPaletteOpen: true,
        defaultAgentPermissionMode: "workspace-write",
    });
    mocks.available.mockResolvedValue([
        { type: "codex", label: "Codex", command: "codex", defaultModel: null, defaultEffort: null },
        { type: "pi", label: "Pi", command: "pi", defaultModel: null, defaultEffort: null },
    ]);
    invalidate((kind) => kind === "agents.catalog");
});

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

describe("AgentPalette", () => {
    it("restores the modal picker without any agent input or worktree UI", async () => {
        const opener = document.createElement("button");
        document.body.append(opener);
        opener.focus();
        const view = render(<AgentPalette />);

        expect(await screen.findByRole("dialog", { name: "Open agent CLI" })).toHaveAttribute("aria-modal", "true");
        expect(screen.getByRole("button", { name: "Start Codex in Normal mode" })).toHaveFocus();
        expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
        expect(screen.queryByText(/worktree/i)).not.toBeInTheDocument();
        expect(screen.queryByText(/model/i)).not.toBeInTheDocument();
        expect(screen.getAllByRole("radio").map((radio) => radio.textContent)).toEqual(["Normal", "YOLO"]);

        view.unmount();
        expect(opener).toHaveFocus();
        opener.remove();
    });

    it("opens the selected CLI directly in a PTY using Normal mode", async () => {
        const user = userEvent.setup();
        render(<AgentPalette />);

        await user.click(await screen.findByRole("button", { name: "Start Codex in Normal mode" }));

        const id = getState().agentsBySession["sess-project"][0];
        expect(getState().agents[id]).toMatchObject({
            type: "codex",
            cwd: "/code/sikemux",
            permissionMode: "workspace-write",
            startup: "codex --sandbox workspace-write",
            directCommand: { program: "codex", args: ["--sandbox", "workspace-write"] },
        });
        expect(getState().agents[id]).not.toHaveProperty("initialInput");
        expect(getState().agents[id]).not.toHaveProperty("worktreePath");
        expect(getState().agentPaletteOpen).toBe(false);
    });

    it("offers YOLO as the only alternate mode and disables unsupported CLIs", async () => {
        const user = userEvent.setup();
        render(<AgentPalette />);

        await user.click(screen.getByRole("radio", { name: "YOLO" }));
        const codex = screen.getByRole("button", { name: "Start Codex in YOLO mode" });
        expect(screen.getByRole("button", { name: "Start Pi in YOLO mode" })).toBeDisabled();
        await user.click(codex);

        const id = getState().agentsBySession["sess-project"][0];
        expect(getState().agents[id]).toMatchObject({ permissionMode: "bypass", skipPermissions: true });
        expect(getState().agents[id].directCommand?.args).toEqual(["--dangerously-bypass-approvals-and-sandbox"]);
    });

    it("supports arrow navigation and Escape dismissal", async () => {
        render(<AgentPalette />);
        const codex = await screen.findByRole("button", { name: "Start Codex in Normal mode" });
        const pi = screen.getByRole("button", { name: "Start Pi in Normal mode" });

        fireEvent.keyDown(codex, { key: "ArrowDown" });
        expect(pi).toHaveFocus();
        fireEvent.keyDown(pi, { key: "Escape" });
        expect(getState().agentPaletteOpen).toBe(false);
    });

    it("reports and retries CLI detection failures", async () => {
        const user = userEvent.setup();
        mocks.available
            .mockRejectedValueOnce(new Error("missing PATH"))
            .mockResolvedValueOnce([{ type: "codex", label: "Codex", command: "codex", defaultModel: null, defaultEffort: null }]);
        invalidate((kind) => kind === "agents.catalog");
        render(<AgentPalette />);

        expect(await screen.findByText(/missing PATH/)).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Try again" }));
        await waitFor(() => expect(screen.getByRole("button", { name: "Start Codex in Normal mode" })).toBeInTheDocument());
    });
});

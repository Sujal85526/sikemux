import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type { TerminalPane } from "../terminal/TerminalPane";
import { getState, setState } from "../state/store";
import { Workspace } from "./Workspace";

vi.mock("../terminal/TerminalPane", () => ({
    TerminalPane: (props: ComponentProps<typeof TerminalPane>) => (
        <div data-testid={`terminal-${props.context?.agentId ?? "window"}`} data-visible={String(props.visible)} />
    ),
}));

const initial = getState();

beforeEach(() => setState(initial, true));
afterEach(cleanup);

function projectWithAgent(resumable = true): string {
    const state = getState();
    const sessionId = state.activeSessionId;
    const session = state.sessions[sessionId];
    setState({
        sessions: {
            ...state.sessions,
            [sessionId]: { ...session, kind: "project", view: "agent", activeAgentId: "agent-only", cwd: "/repo" },
        },
        agents: {
            "agent-only": {
                id: "agent-only",
                type: "codex",
                title: "only agent",
                startup: "codex",
                directCommand: {
                    program: "codex",
                    args: resumable ? ["resume", "--sandbox", "workspace-write", "session-only"] : ["--sandbox", "workspace-write"],
                },
                ...(resumable ? { resumeId: "session-only" } : {}),
                permissionMode: "workspace-write",
                launchState: "live",
            },
        },
        agentsBySession: { ...state.agentsBySession, [sessionId]: ["agent-only"] },
    });
    return sessionId;
}

describe("workspace tab bars", () => {
    it("keeps the terminal tab bar and new-terminal action visible with one terminal", () => {
        const { container } = render(<Workspace />);

        expect(screen.getByRole("tablist")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "New terminal — ⌥N" })).toBeInTheDocument();
        expect(container.querySelector(".window-layer.visible")).toHaveStyle({ top: "34px" });
    });

    it("keeps the agent tab bar and new-agent action visible with one agent", () => {
        projectWithAgent();

        const { container } = render(<Workspace />);

        expect(screen.getByRole("tablist")).toBeInTheDocument();
        const addAgent = screen.getByRole("button", { name: "New agent — ⌥N" });
        expect(addAgent).toBeInTheDocument();
        expect(container.querySelector(".window-layer.visible .pane-cell")).toHaveStyle({ top: "34px", height: "calc(100% - 34px)" });

        fireEvent.click(addAgent);
        expect(getState().agentPaletteOpen).toBe(true);
    });

    it("restores the one-click PTY toggle and remounts a fresh CLI in YOLO mode", () => {
        projectWithAgent(false);
        render(<Workspace />);

        const originalTerminal = screen.getByTestId("terminal-agent-only");
        const toggle = screen.getByRole("button", { name: /safe/i });
        expect(toggle).toHaveAttribute("aria-pressed", "false");
        expect(toggle).not.toBeDisabled();
        fireEvent.click(toggle);

        expect(getState().agents["agent-only"]).toMatchObject({
            permissionMode: "bypass",
            skipPermissions: true,
            directCommand: { program: "codex", args: ["--dangerously-bypass-approvals-and-sandbox"] },
        });
        expect(screen.getByRole("button", { name: /yolo/i })).toHaveAttribute("aria-pressed", "true");
        expect(screen.getByTestId("terminal-agent-only")).not.toBe(originalTerminal);
    });

    it("shows YOLO as the animated live-session state", () => {
        projectWithAgent();
        setState((state) => ({
            agents: { ...state.agents, "agent-only": { ...state.agents["agent-only"], permissionMode: "bypass", skipPermissions: true } },
        }));

        render(<Workspace />);

        expect(screen.getByRole("button", { name: /yolo/i })).toHaveClass("yolo-toggle", "on");
        expect(screen.getByRole("button", { name: /yolo/i })).toHaveAttribute("aria-pressed", "true");
    });

    it("keeps the empty agent stage free of input UI", () => {
        const state = getState();
        const sessionId = state.activeSessionId;
        setState({
            sessions: {
                ...state.sessions,
                [sessionId]: { ...state.sessions[sessionId], kind: "project", view: "agent", activeAgentId: null, cwd: "/repo" },
            },
            agentsBySession: { ...state.agentsBySession, [sessionId]: [] },
        });

        render(<Workspace />);

        expect(screen.getByText("no agents in this project")).toBeInTheDocument();
        expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    });
});

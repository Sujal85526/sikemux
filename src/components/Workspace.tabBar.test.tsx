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

function projectWithAgent(): string {
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
                directCommand: { program: "codex", args: ["resume", "--sandbox", "workspace-write", "session-only"] },
                resumeId: "session-only",
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
        expect(screen.getByTitle("New terminal — ⌥N")).toBeInTheDocument();
        expect(container.querySelector(".window-layer.visible")).toHaveStyle({ top: "32px" });
    });

    it("keeps the agent tab bar and new-agent action visible with one agent", () => {
        projectWithAgent();

        const { container } = render(<Workspace />);

        expect(screen.getByRole("tablist")).toBeInTheDocument();
        const addAgent = screen.getByTitle("New agent — ⌥N");
        expect(addAgent).toBeInTheDocument();
        expect(container.querySelector(".window-layer.visible .pane-cell")).toHaveStyle({ top: "32px", height: "calc(100% - 32px)" });

        fireEvent.click(addAgent);
        expect(getState().agentPaletteOpen).toBe(true);
    });

    it("changes between Normal and YOLO in a resumable agent session", () => {
        projectWithAgent();
        render(<Workspace />);

        const safety = screen.getByRole("button", { name: "Safety" });
        expect(safety).toHaveTextContent("Normal");
        fireEvent.click(safety);

        const menu = screen.getByRole("listbox", { name: "Safety" });
        expect(screen.getByRole("option", { name: /Normal/ })).toBeInTheDocument();
        expect(screen.getByRole("option", { name: /YOLO/ })).toBeInTheDocument();
        expect(screen.getAllByRole("option")).toHaveLength(2);

        fireEvent.click(screen.getByRole("option", { name: /YOLO/ }));
        expect(getState().agents["agent-only"].permissionMode).toBe("bypass");
        expect(screen.getByRole("button", { name: "Safety" })).toHaveTextContent("YOLO");
        expect(menu).not.toBeInTheDocument();
    });

    it("shows YOLO as the animated live-session state", () => {
        projectWithAgent();
        setState((state) => ({
            agents: { ...state.agents, "agent-only": { ...state.agents["agent-only"], permissionMode: "bypass", skipPermissions: true } },
        }));

        render(<Workspace />);

        expect(screen.getByRole("button", { name: "Safety" })).toHaveTextContent("YOLO");
        expect(screen.getByRole("button", { name: "Safety" })).toHaveClass("is-yolo");
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

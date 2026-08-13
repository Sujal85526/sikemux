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

vi.mock("./AgentPalette", () => ({ AgentPalette: () => <div data-testid="new-agent-page" /> }));

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

    it("renders the new agent page as a draft tab in the stage instead of an overlay", () => {
        projectWithAgent();
        setState({ agentPaletteOpen: true });

        const { container } = render(<Workspace />);

        const draftTab = screen.getByRole("tab", { name: /New agent/ });
        expect(draftTab).toHaveAttribute("aria-selected", "true");
        expect(screen.getByRole("tab", { name: /only agent/ })).toHaveAttribute("aria-selected", "false");
        expect(screen.getByTestId("new-agent-page")).toBeInTheDocument();
        expect(container.querySelector(".new-agent-layer")).toHaveStyle({ top: "32px" });
        // The agent behind the draft backgrounds instead of painting through it.
        expect(screen.getByTestId("terminal-agent-only")).toHaveAttribute("data-visible", "false");

        fireEvent.click(screen.getByRole("tab", { name: /only agent/ }));
        expect(getState().agentPaletteOpen).toBe(false);
    });

    it("changes every supported safety boundary in a resumable agent session", () => {
        projectWithAgent();
        render(<Workspace />);

        const safety = screen.getByRole("button", { name: "Safety" });
        expect(safety).toHaveTextContent("Build");
        fireEvent.click(safety);

        const menu = screen.getByRole("listbox", { name: "Safety" });
        expect(screen.getByRole("option", { name: /Observe/ })).toBeInTheDocument();
        expect(screen.getByRole("option", { name: /Operate/ })).toBeInTheDocument();
        expect(screen.getByRole("option", { name: /YOLO/ })).toBeInTheDocument();

        fireEvent.click(screen.getByRole("option", { name: /Observe/ }));
        expect(getState().agents["agent-only"].permissionMode).toBe("read-only");
        expect(screen.getByRole("button", { name: "Safety" })).toHaveTextContent("Observe");
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

    it("shows the draft tab instead of the empty stage when no agent is open yet", () => {
        const state = getState();
        const sessionId = state.activeSessionId;
        setState({
            sessions: {
                ...state.sessions,
                [sessionId]: { ...state.sessions[sessionId], kind: "project", view: "agent", activeAgentId: null, cwd: "/repo" },
            },
            agentsBySession: { ...state.agentsBySession, [sessionId]: [] },
            agentPaletteOpen: true,
        });

        render(<Workspace />);

        expect(screen.getByRole("tab", { name: /New agent/ })).toBeInTheDocument();
        expect(screen.queryByText("no agents in this project")).not.toBeInTheDocument();

        fireEvent.click(screen.getByTitle("Close New agent"));
        expect(getState().agentPaletteOpen).toBe(false);
    });
});

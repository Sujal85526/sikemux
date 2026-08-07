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

describe("workspace tab bars", () => {
    it("keeps the terminal tab bar and new-terminal action visible with one terminal", () => {
        const { container } = render(<Workspace />);

        expect(screen.getByRole("tablist")).toBeInTheDocument();
        expect(screen.getByTitle("New terminal — ⌥N")).toBeInTheDocument();
        expect(container.querySelector(".window-layer.visible")).toHaveStyle({ top: "32px" });
    });

    it("keeps the agent tab bar and new-agent action visible with one agent", () => {
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
                    launchState: "live",
                },
            },
            agentsBySession: { ...state.agentsBySession, [sessionId]: ["agent-only"] },
        });

        const { container } = render(<Workspace />);

        expect(screen.getByRole("tablist")).toBeInTheDocument();
        const addAgent = screen.getByTitle("New agent — ⌥N");
        expect(addAgent).toBeInTheDocument();
        expect(container.querySelector(".window-layer.visible .pane-cell")).toHaveStyle({ top: "32px", height: "calc(100% - 32px)" });

        fireEvent.click(addAgent);
        expect(getState().agentPaletteOpen).toBe(true);
    });
});

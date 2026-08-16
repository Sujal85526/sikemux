import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type { TerminalPane } from "../terminal/TerminalPane";
import { getState, setState } from "../state/store";
import { Workspace } from "./Workspace";

vi.mock("../terminal/TerminalPane", () => ({
    TerminalPane: (props: ComponentProps<typeof TerminalPane>) => (
        <div
            data-testid={`terminal-${props.context?.agentId ?? "window"}`}
            data-visible={String(props.visible)}
            data-spawn-when={String(props.spawnWhen)}
        />
    ),
}));

const initial = getState();

beforeEach(() => setState(initial, true));
afterEach(cleanup);

function arrangeRestoredAgents(resumeId: string | undefined): void {
    const state = getState();
    const sessionId = state.activeSessionId;
    const session = state.sessions[sessionId];
    setState({
        sessions: {
            ...state.sessions,
            [sessionId]: { ...session, kind: "project", view: "agent", activeAgentId: "agent-visible", cwd: "/repo" },
        },
        agents: {
            "agent-visible": {
                id: "agent-visible",
                type: "codex",
                title: "visible",
                startup: "codex resume visible-session",
                resumeId: "visible-session",
                launchState: "live",
            },
            "agent-hidden": {
                id: "agent-hidden",
                type: "claude",
                title: "hidden",
                startup: "claude --resume hidden-session",
                resumeId,
                launchState: "live",
            },
        },
        agentsBySession: { ...state.agentsBySession, [sessionId]: ["agent-visible", "agent-hidden"] },
    });
}

describe("restored agent lifecycle", () => {
    it("spawns a hidden restored agent that has a session to resume", () => {
        arrangeRestoredAgents("hidden-session");
        render(<Workspace />);

        expect(screen.getByTestId("terminal-agent-hidden")).toHaveAttribute("data-visible", "false");
        expect(screen.getByTestId("terminal-agent-hidden")).toHaveAttribute("data-spawn-when", "true");
    });

    it("leaves a hidden agent with nothing to resume inert until it is shown", () => {
        arrangeRestoredAgents(undefined);
        render(<Workspace />);

        expect(screen.getByTestId("terminal-agent-hidden")).toHaveAttribute("data-spawn-when", "false");
    });
});

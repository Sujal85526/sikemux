import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitTerminal } from "./GitTerminal";

const { spawns, lastOnExit } = vi.hoisted(() => ({
    spawns: { count: 0 },
    lastOnExit: { fn: null as null | (() => void) },
}));

// Stand in for the real pane: one mount == one shell. The component under test
// respawns by remounting, so the mount counter is the observable behaviour.
vi.mock("../../terminal/TerminalPane", () => ({
    TerminalPane: ({ onExit }: { onExit?: () => void }) => {
        lastOnExit.fn = onExit ?? null;
        spawns.count += 1;
        return <div data-testid="terminal-pane" />;
    },
}));

const exitShell = () => act(() => lastOnExit.fn?.());

beforeEach(() => {
    vi.useFakeTimers();
    spawns.count = 0;
    lastOnExit.fn = null;
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

describe("GitTerminal", () => {
    it("replaces the shell with a fresh one when it exits", () => {
        render(<GitTerminal repo="/repo" visible />);
        expect(spawns.count).toBe(1);

        // A shell that ran for a while before exiting is a deliberate `exit`.
        act(() => void vi.advanceTimersByTime(30_000));
        exitShell();

        expect(spawns.count).toBe(2);
        expect(screen.getByTestId("terminal-pane")).toBeInTheDocument();
    });

    it("keeps respawning across repeated deliberate exits", () => {
        render(<GitTerminal repo="/repo" visible />);
        for (let i = 0; i < 5; i++) {
            act(() => void vi.advanceTimersByTime(30_000));
            exitShell();
        }
        expect(spawns.count).toBe(6);
        expect(screen.getByTestId("terminal-pane")).toBeInTheDocument();
    });

    it("stops the loop when the shell dies instantly over and over", () => {
        render(<GitTerminal repo="/repo" visible />);
        exitShell();
        exitShell();
        exitShell();

        expect(screen.queryByTestId("terminal-pane")).not.toBeInTheDocument();
        const restart = screen.getByRole("button", { name: /start a new shell/i });

        act(() => void fireEvent.click(restart));
        expect(screen.getByTestId("terminal-pane")).toBeInTheDocument();
    });

    it("restarts on demand from the header button", () => {
        render(<GitTerminal repo="/repo" visible />);
        expect(spawns.count).toBe(1);

        act(() => void fireEvent.click(screen.getByRole("button", { name: /restart this shell/i })));
        expect(spawns.count).toBe(2);
    });
});

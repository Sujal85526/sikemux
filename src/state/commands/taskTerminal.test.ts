import { beforeEach, describe, expect, it } from "vitest";
import * as cmd from "../commands";
import { getState, setState } from "../store";
import type { TaskTerminalPresentationRequest } from "../../tasks/nativeRuntime";

const initial = getState();

beforeEach(() => setState(initial, true));

function presentation(overrides: Partial<TaskTerminalPresentationRequest> = {}): TaskTerminalPresentationRequest {
    return {
        executionId: "execution-1",
        terminalKey: "task:test:/work/demo",
        taskId: "test",
        label: "Test",
        project: "/work/demo",
        source: "project",
        cwd: "/work/demo",
        signal: new AbortController().signal,
        ...overrides,
    };
}

describe("task terminal presentation", () => {
    it("creates a transient secret-free window in the owning project", () => {
        cmd.createProjectSession("/work/demo");
        const paneId = cmd.openTaskTerminal(presentation());
        const state = getState();
        const session = state.sessions[state.activeSessionId];
        const window = state.windows[session.activeWindowId];

        expect(window).toMatchObject({ name: "Test", role: "named", transient: true, activePaneId: paneId });
        expect(window.root).toMatchObject({
            type: "pane",
            id: paneId,
            cwd: "/work/demo",
            title: "Test",
            externalPty: true,
            taskTerminalKey: "task:test:/work/demo",
        });
        expect(JSON.stringify(window)).not.toContain("pnpm test");
        expect(JSON.stringify(window)).not.toContain("NODE_ENV");
    });

    it("reuses the same task pane while updating safe presentation metadata", () => {
        cmd.createProjectSession("/work/demo");
        const first = cmd.openTaskTerminal(presentation());
        const second = cmd.openTaskTerminal(presentation({ executionId: "execution-2", label: "Test again", cwd: "/work/demo/package" }));
        const state = getState();
        const taskWindows = Object.values(state.windows).filter((window) => window.transient);

        expect(second).toBe(first);
        expect(taskWindows).toHaveLength(1);
        expect(taskWindows[0]).toMatchObject({ name: "Test again", root: { id: first, cwd: "/work/demo/package", title: "Test again" } });
    });

    it("rejects closed projects, escaped directories, and cancelled presentation", () => {
        expect(() => cmd.openTaskTerminal(presentation())).toThrow("no longer open");
        cmd.createProjectSession("/work/demo");
        expect(() => cmd.openTaskTerminal(presentation({ cwd: "/work/outside" }))).toThrow("stay within");
        const abort = new AbortController();
        abort.abort(new Error("cancelled"));
        expect(() => cmd.openTaskTerminal(presentation({ signal: abort.signal }))).toThrow("cancelled");
    });
});

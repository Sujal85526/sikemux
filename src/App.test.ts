import { describe, expect, it } from "vitest";
import { activeTaskControls } from "./App";
import type { ResolvedTaskDefinition, TaskControllerSnapshot, TaskLifecycleState } from "./tasks/taskRegistry";

function task(id: string): ResolvedTaskDefinition {
    return Object.freeze({
        id,
        label: id,
        project: "/repo",
        command: `run ${id}`,
        cwd: "/repo",
        env: Object.freeze({}),
        source: "project",
    });
}

function snapshot(status: TaskLifecycleState, activeRunId: number | null, activeTask: ResolvedTaskDefinition | null): TaskControllerSnapshot {
    return Object.freeze({
        revision: 1,
        status,
        disposed: false,
        task: activeTask,
        activeRunId,
        runAttempts: 1,
        failures: Object.freeze([]),
    });
}

describe("active task command reachability", () => {
    it.each(["running", "stopping", "failed"] as const)("keeps Stop reachable for an owned PTY in %s state after discovery clears", (status) => {
        expect(activeTaskControls(snapshot(status, 7, task("watch")), [])).toEqual({
            canStop: true,
            restartTaskId: null,
        });
    });

    it("allows restart only through the current project inventory", () => {
        const running = snapshot("running", 7, task("watch"));

        expect(activeTaskControls(running, [task("watch")])).toEqual({ canStop: true, restartTaskId: "watch" });
        expect(activeTaskControls(running, [task("build")])).toEqual({ canStop: true, restartTaskId: null });
    });

    it("does not expose Stop for a settled or disposed controller", () => {
        expect(activeTaskControls(snapshot("failed", null, task("watch")), [task("watch")])).toEqual({
            canStop: false,
            restartTaskId: "watch",
        });
        expect(activeTaskControls({ ...snapshot("running", 7, task("watch")), disposed: true }, [task("watch")])).toEqual({
            canStop: false,
            restartTaskId: null,
        });
    });
});

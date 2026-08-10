import { describe, expect, it, vi } from "vitest";
import type { TaskExecutionRequest, TaskProcessExit, TaskTerminalOpenRequest } from "./runtime";
import {
    NativeTaskExecutionBackend,
    TaskPtyBindingRegistry,
    WorkbenchTaskTerminalSurface,
    type TaskExitChannel,
    type TaskCommandInvoker,
    type TaskTerminalPresentationRequest,
} from "./nativeRuntime";

const request = Object.freeze({
    executionId: "execution-1",
    terminalKey: "terminal-1",
    taskId: "test",
    label: "Test",
    project: "/repo",
    source: "project" as const,
    command: "pnpm test",
    cwd: "/repo",
    env: Object.freeze({ NODE_ENV: "test" }),
    cols: 80,
    rows: 24,
}) satisfies TaskExecutionRequest;

function deferred<Value>() {
    let resolve!: (value: Value) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

describe("NativeTaskExecutionBackend", () => {
    it("passes the structured request and channel by identity and observes immediate exit", async () => {
        const channel: TaskExitChannel = { onmessage: () => {} };
        const invoke = vi.fn(async <Result>(command: string, args?: unknown) => {
            expect(command).toBe("task_spawn");
            expect((args as { request: unknown }).request).toBe(request);
            expect((args as { onExit: unknown }).onExit).toBe(channel);
            channel.onmessage(Object.freeze({ code: 0 }));
            return { ptyId: 42 } as Result;
        });
        const backend = new NativeTaskExecutionBackend({ invoke: invoke as TaskCommandInvoker, createExitChannel: () => channel });

        const started = await backend.start(request);
        expect(started.ptyId).toBe(42);
        await expect(started.completion).resolves.toEqual({ code: 0 });
    });

    it("uses the first exit only and stops the exact PTY", async () => {
        const channel: TaskExitChannel = { onmessage: () => {} };
        const invoke = vi.fn(async <Result>(command: string) => ({ ptyId: command === "task_spawn" ? 7 : undefined }) as Result);
        const backend = new NativeTaskExecutionBackend({ invoke: invoke as TaskCommandInvoker, createExitChannel: () => channel });
        const started = await backend.start(request);
        const first: TaskProcessExit = { code: 3, signal: "TERM" };
        channel.onmessage(first);
        channel.onmessage({ code: 0 });

        await expect(started.completion).resolves.toBe(first);
        await backend.stop(7);
        expect(invoke).toHaveBeenLastCalledWith("pty_kill", { id: 7 });
    });

    it("rejects start and contains the orphaned completion when native spawn fails", async () => {
        const channel = { onmessage: (_exit: TaskProcessExit) => {} };
        const backend = new NativeTaskExecutionBackend({
            invoke: async () => {
                throw new Error("native detail");
            },
            createExitChannel: () => channel,
        });
        await expect(backend.start(request)).rejects.toThrow("native detail");
        expect(() => channel.onmessage({ code: 0 })).not.toThrow();
    });
});

describe("TaskPtyBindingRegistry", () => {
    it("publishes immutable replacements and protects them from stale release", () => {
        const registry = new TaskPtyBindingRegistry({ maxBindings: 2, maxListenersPerPane: 2, maxTotalListeners: 2 });
        const listener = vi.fn();
        const unsubscribe = registry.subscribe("pane-1", listener);
        const first = registry.bind("pane-1", { ptyId: 1, executionId: "one", terminalKey: "task" });
        const second = registry.bind("pane-1", { ptyId: 2, executionId: "two", terminalKey: "task" });

        expect(Object.isFrozen(first)).toBe(true);
        expect(second.revision).toBeGreaterThan(first.revision);
        expect(registry.release("pane-1", "one")).toBe(false);
        expect(registry.getSnapshot("pane-1")).toBe(second);
        expect(registry.release("pane-1", "two")).toBe(true);
        expect(registry.getSnapshot("pane-1")).toBeNull();
        expect(listener).toHaveBeenCalledTimes(3);
        unsubscribe();
        unsubscribe();
    });

    it("bounds entries and listeners without evicting live bindings", () => {
        const registry = new TaskPtyBindingRegistry({ maxBindings: 1, maxListenersPerPane: 1, maxTotalListeners: 1 });
        registry.bind("pane-1", { ptyId: 1, executionId: "one", terminalKey: "one" });
        expect(() => registry.bind("pane-2", { ptyId: 2, executionId: "two", terminalKey: "two" })).toThrow(/capacity/);
        const unsubscribe = registry.subscribe("pane-1", () => {});
        expect(() => registry.subscribe("pane-1", () => {})).toThrow(/capacity/);
        unsubscribe();
    });
});

describe("WorkbenchTaskTerminalSurface", () => {
    it("presents only secret-free metadata before binding the exact PTY", async () => {
        const bindings = new TaskPtyBindingRegistry();
        const presented = deferred<string>();
        const present = vi.fn((_value: TaskTerminalPresentationRequest) => presented.promise);
        const surface = new WorkbenchTaskTerminalSurface(bindings, present);
        const abort = new AbortController();
        const openRequest: TaskTerminalOpenRequest = Object.freeze({
            executionId: request.executionId,
            terminalKey: request.terminalKey,
            ptyId: 44,
            taskId: request.taskId,
            label: request.label,
            project: request.project,
            source: request.source,
            cwd: request.cwd,
            signal: abort.signal,
        });

        const opening = surface.open(openRequest);
        expect(present).toHaveBeenCalledWith(
            expect.not.objectContaining({ ptyId: expect.anything(), command: expect.anything(), env: expect.anything() }),
        );
        expect(bindings.getSnapshot("pane-task")).toBeNull();
        presented.resolve("pane-task");
        await opening;
        expect(bindings.getSnapshot("pane-task")).toMatchObject({ ptyId: 44, executionId: request.executionId });
    });

    it("does not bind a presentation that was cancelled while opening", async () => {
        const bindings = new TaskPtyBindingRegistry();
        const presented = deferred<string>();
        const abort = new AbortController();
        const surface = new WorkbenchTaskTerminalSurface(bindings, () => presented.promise);
        const opening = surface.open({
            executionId: "cancelled",
            terminalKey: "task",
            ptyId: 5,
            taskId: "test",
            label: "Test",
            project: "/repo",
            source: "project",
            cwd: "/repo",
            signal: abort.signal,
        });
        abort.abort(new Error("cancelled"));
        presented.resolve("pane-task");

        await expect(opening).rejects.toThrow("cancelled");
        expect(bindings.getSnapshot("pane-task")).toBeNull();
    });
});

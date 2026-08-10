import { describe, expect, it, vi } from "vitest";
import { MemoryIpcTransport } from "../api/transport";
import {
    NativeTaskExecutionBackend,
    TaskPtyBindingRegistry,
    WorkbenchTaskTerminalSurface,
    type TaskCommandInvoker,
    type TaskExitChannel,
    type TaskTerminalPresentationRequest,
} from "./nativeRuntime";
import { TaskRuntime, type TaskExecutionRequest, type TaskProcessExit } from "./runtime";
import { TaskRegistry } from "./taskRegistry";

interface Deferred<Value> {
    readonly promise: Promise<Value>;
    readonly resolve: (value: Value | PromiseLike<Value>) => void;
}

function deferred<Value>(): Deferred<Value> {
    let resolve!: (value: Value | PromiseLike<Value>) => void;
    const promise = new Promise<Value>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

interface SpawnArguments {
    readonly request: TaskExecutionRequest;
    readonly onExit: TaskExitChannel;
}

describe("project task flow", () => {
    it("carries the exact PTY through immediate exit, restart, presentation, and cleanup without duplicate native calls", async () => {
        const project = "/workspace/integration";
        const paneId = "task-terminal-pane";
        const registry = new TaskRegistry();
        registry.replaceSource("project", [
            {
                id: "check",
                label: "Check workspace",
                project,
                command: "pnpm check --filter app",
                cwd: `${project}/app`,
                env: { NODE_ENV: "test", TASK_TOKEN: "renderer-must-not-see-this" },
            },
        ]);

        const transport = new MemoryIpcTransport();
        const spawnArguments: SpawnArguments[] = [];
        const killedPtyIds: number[] = [];
        const assignedPtyIds = [701, 702, 703] as const;
        const channels: TaskExitChannel[] = [];
        const firstPresentation = deferred<string>();
        const presentations: TaskTerminalPresentationRequest[] = [];

        transport.register("task_spawn", (rawArguments) => {
            const argumentsValue = rawArguments as SpawnArguments;
            const ptyId = assignedPtyIds[spawnArguments.length];
            if (ptyId === undefined) throw new Error("unexpected duplicate task spawn");
            spawnArguments.push(argumentsValue);
            if (ptyId === assignedPtyIds[0]) {
                argumentsValue.onExit.onmessage(Object.freeze({ code: 0 } satisfies TaskProcessExit));
            }
            return Object.freeze({ ptyId });
        });
        transport.register("pty_kill", (rawArguments) => {
            const ptyId = (rawArguments as { readonly id: number }).id;
            killedPtyIds.push(ptyId);
        });

        const invoke: TaskCommandInvoker = (command, argumentsValue) => transport.invoke(command, argumentsValue);
        const backend = new NativeTaskExecutionBackend({
            invoke,
            createExitChannel: () => {
                const channel: TaskExitChannel = { onmessage: () => {} };
                channels.push(channel);
                return channel;
            },
        });
        const bindings = new TaskPtyBindingRegistry();
        const presenter = vi.fn((request: TaskTerminalPresentationRequest) => {
            presentations.push(request);
            return presentations.length === 1 ? firstPresentation.promise : paneId;
        });
        const surface = new WorkbenchTaskTerminalSurface(bindings, presenter);
        const runtime = new TaskRuntime({ registry, backend, surface, cols: 132, rows: 43 });

        await runtime.run(project, "check");

        expect(spawnArguments).toHaveLength(1);
        expect(spawnArguments[0]!.onExit).toBe(channels[0]);
        expect(spawnArguments[0]!.request).toMatchObject({
            taskId: "check",
            label: "Check workspace",
            project,
            source: "project",
            command: "pnpm check --filter app",
            cwd: `${project}/app`,
            env: { NODE_ENV: "test", TASK_TOKEN: "renderer-must-not-see-this" },
            cols: 132,
            rows: 43,
        });
        expect(presentations[0]).toEqual(
            expect.not.objectContaining({
                ptyId: expect.anything(),
                command: expect.anything(),
                env: expect.anything(),
            }),
        );
        expect(bindings.getSnapshot(paneId)).toBeNull();
        expect(runtime.getSnapshot(project)).toMatchObject({ status: "running", activeRunId: 1 });

        firstPresentation.resolve(paneId);
        await vi.waitFor(() => expect(bindings.getSnapshot(paneId)?.ptyId).toBe(assignedPtyIds[0]));
        await vi.waitFor(() => expect(runtime.getSnapshot(project)?.status).toBe("idle"));
        expect(killedPtyIds).toEqual([]);

        await runtime.restart(project, "check");
        await vi.waitFor(() => expect(bindings.getSnapshot(paneId)?.ptyId).toBe(assignedPtyIds[1]));
        expect(spawnArguments).toHaveLength(2);
        expect(spawnArguments[1]!.onExit).toBe(channels[1]);
        expect(killedPtyIds).toEqual([]);

        await runtime.restart(project, "check");
        await vi.waitFor(() => expect(bindings.getSnapshot(paneId)?.ptyId).toBe(assignedPtyIds[2]));
        expect(spawnArguments).toHaveLength(3);
        expect(spawnArguments[2]!.onExit).toBe(channels[2]);
        expect(killedPtyIds).toEqual([assignedPtyIds[1]]);

        const dispose = runtime.dispose();
        expect(runtime.dispose()).toBe(dispose);
        await dispose;
        expect(killedPtyIds).toEqual([assignedPtyIds[1], assignedPtyIds[2]]);
        expect(new Set(killedPtyIds).size).toBe(killedPtyIds.length);
        expect(spawnArguments.map(({ request }) => request.executionId)).toHaveLength(3);
        expect(new Set(spawnArguments.map(({ request }) => request.executionId)).size).toBe(3);

        const finalBinding = bindings.getSnapshot(paneId);
        expect(finalBinding).toMatchObject({ ptyId: assignedPtyIds[2], terminalKey: spawnArguments[2]!.request.terminalKey });
        expect(bindings.release(paneId, finalBinding!.executionId)).toBe(true);
        expect(bindings.release(paneId, finalBinding!.executionId)).toBe(false);
        expect(bindings.getSnapshot(paneId)).toBeNull();
        expect(spawnArguments).toHaveLength(3);
        expect(killedPtyIds).toEqual([assignedPtyIds[1], assignedPtyIds[2]]);
    });
});

import { describe, expect, it, vi } from "vitest";
import {
    PtyControllerDisposedError,
    PtyControllerExitedError,
    PtyLifecycleController,
    PtySubscriptionOverflowError,
    type PtyApi,
    type PtyAttachResult,
    type PtyChannelAdapter,
    type PtyControllerErrorEvent,
    type PtyOutputChunk,
    type PtySpawnRequest,
    type PtyTimerAdapter,
} from "./ptyController";

type TestContext = { readonly paneId: string };
type FakeChannel = { readonly id: number };

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

class FakeChannels implements PtyChannelAdapter<FakeChannel> {
    readonly bindings: {
        transport: FakeChannel;
        emit: (chunk: PtyOutputChunk) => void;
        close: ReturnType<typeof vi.fn>;
    }[] = [];

    create(onMessage: (chunk: PtyOutputChunk) => void) {
        const binding = {
            transport: { id: this.bindings.length + 1 },
            emit: onMessage,
            close: vi.fn(),
        };
        this.bindings.push(binding);
        return { transport: binding.transport, close: binding.close };
    }
}

class FakeTimer implements PtyTimerAdapter {
    readonly jobs = new Map<number, () => void>();
    readonly schedule = vi.fn((callback: () => void, _delayMs: number): number => {
        const id = this.jobs.size + 1;
        this.jobs.set(id, callback);
        return id;
    });
    readonly cancel = vi.fn((handle: unknown) => {
        this.jobs.delete(handle as number);
    });

    runAll(): void {
        const callbacks = Array.from(this.jobs.values());
        this.jobs.clear();
        callbacks.forEach((callback) => callback());
    }
}

function fakeApi() {
    const spawn = vi.fn(async (_request: PtySpawnRequest<TestContext>) => 42);
    const write = vi.fn(async (_id: number, _data: string) => {});
    const resize = vi.fn(async (_id: number, _cols: number, _rows: number) => {});
    const kill = vi.fn(async (_id: number) => {});
    const attach = vi.fn(async (_id: number, _channel: FakeChannel): Promise<PtyAttachResult> => {
        return { subId: 7, snapshot: [1, 2], alternateScreen: false };
    });
    const detach = vi.fn(async (_id: number, _subId: number) => {});
    const api = { spawn, write, resize, kill, attach, detach } satisfies PtyApi<FakeChannel, TestContext>;
    return { api, spawn, write, resize, kill, attach, detach };
}

function controllerOptions(overrides: Partial<ConstructorParameters<typeof PtyLifecycleController<FakeChannel, TestContext>>[0]> = {}) {
    const fakes = fakeApi();
    const channels = new FakeChannels();
    const errors: PtyControllerErrorEvent[] = [];
    return {
        fakes,
        channels,
        errors,
        options: {
            api: fakes.api,
            channels,
            cwd: "/repo",
            startup: "codex",
            context: { paneId: "pane-1" },
            onError: (event: PtyControllerErrorEvent) => errors.push(event),
            ...overrides,
        },
    };
}

describe("PtyLifecycleController process ownership", () => {
    it("coalesces concurrent starts and owns write and resize operations", async () => {
        const spawned = deferred<number>();
        const { fakes, options } = controllerOptions();
        fakes.spawn.mockReturnValue(spawned.promise);
        const controller = new PtyLifecycleController(options);

        const first = controller.start();
        const second = controller.start();
        expect(first).toBe(second);
        expect(fakes.spawn).toHaveBeenCalledOnce();
        expect(fakes.spawn).toHaveBeenCalledWith({
            cols: 80,
            rows: 24,
            cwd: "/repo",
            startup: "codex",
            context: { paneId: "pane-1" },
        });

        spawned.resolve(42);
        await expect(first).resolves.toBe(42);
        await controller.write("echo hi\r");
        await controller.resize(120, 40);

        expect(fakes.write).toHaveBeenCalledTimes(1);
        expect(fakes.write).toHaveBeenCalledWith(42, "echo hi\r");
        expect(fakes.resize).toHaveBeenCalledTimes(1);
        expect(fakes.resize).toHaveBeenCalledWith(42, 120, 40);
        expect(controller.getSnapshot()).toMatchObject({ status: "running", spawnAttempts: 1, cols: 120, rows: 40 });
    });

    it("keeps the newest requested size when concurrent native resizes finish out of order", async () => {
        const firstResize = deferred<void>();
        const secondResize = deferred<void>();
        const { fakes, options } = controllerOptions();
        fakes.resize.mockReturnValueOnce(firstResize.promise).mockReturnValueOnce(secondResize.promise);
        const controller = new PtyLifecycleController(options);
        await controller.start();

        const first = controller.resize(100, 30);
        const second = controller.resize(140, 50);
        await vi.waitFor(() => expect(fakes.resize).toHaveBeenCalledTimes(2));
        secondResize.resolve();
        await second;
        firstResize.resolve();
        await first;

        expect(controller.getSnapshot()).toMatchObject({ cols: 140, rows: 50 });
        expect(fakes.resize).toHaveBeenNthCalledWith(1, 42, 100, 30);
        expect(fakes.resize).toHaveBeenNthCalledWith(2, 42, 140, 50);
    });

    it("retries a failed spawn without killing a process that never existed", async () => {
        const spawnError = Object.freeze({ category: "pty", detail: "spawn failed" });
        const { fakes, errors, options } = controllerOptions();
        fakes.spawn.mockRejectedValueOnce(spawnError).mockResolvedValueOnce(77);
        const controller = new PtyLifecycleController(options);

        await expect(controller.start()).rejects.toBe(spawnError);
        expect(controller.getSnapshot()).toMatchObject({ status: "failed", spawnAttempts: 1, failureOperation: "spawn" });
        await expect(controller.start()).resolves.toBe(77);

        expect(fakes.spawn).toHaveBeenCalledTimes(2);
        expect(fakes.kill).not.toHaveBeenCalled();
        expect(errors).toContainEqual({ operation: "spawn", error: spawnError });
    });

    it("treats an invalid native spawn ID as a retryable spawn failure", async () => {
        const { fakes, options } = controllerOptions();
        fakes.spawn.mockResolvedValueOnce(-1).mockResolvedValueOnce(88);
        const controller = new PtyLifecycleController(options);

        await expect(controller.start()).rejects.toThrow("invalid runtime ID");
        expect(controller.getSnapshot()).toMatchObject({ status: "failed", spawnAttempts: 1, failureOperation: "spawn" });
        await expect(controller.start()).resolves.toBe(88);
        expect(fakes.spawn).toHaveBeenCalledTimes(2);
    });

    it("kills exactly once when disposed during a coalesced start", async () => {
        const spawned = deferred<number>();
        const timer = new FakeTimer();
        const { fakes, options } = controllerOptions({ initialInput: "private first task", timer });
        fakes.spawn.mockReturnValue(spawned.promise);
        const controller = new PtyLifecycleController(options);
        const starting = controller.start();
        const disposing = controller.dispose();

        expect(controller.dispose()).toBe(disposing);
        spawned.resolve(91);

        await expect(starting).rejects.toBeInstanceOf(PtyControllerDisposedError);
        await disposing;
        expect(fakes.kill).toHaveBeenCalledTimes(1);
        expect(fakes.kill).toHaveBeenCalledWith(91);
        expect(fakes.write).not.toHaveBeenCalled();
        expect(timer.schedule).not.toHaveBeenCalled();
        expect(controller.getSnapshot()).toMatchObject({ status: "disposed", attachmentCount: 0, initialInput: "cancelled" });
    });

    it("delivers initial input at most once and reports successful delivery", async () => {
        const timer = new FakeTimer();
        const delivered = vi.fn();
        const { fakes, options } = controllerOptions({ initialInput: "  Build it safely.  ", timer, onInitialInputDelivered: delivered });
        const controller = new PtyLifecycleController(options);

        await controller.start();
        expect(controller.getSnapshot().initialInput).toBe("scheduled");
        expect(fakes.write).not.toHaveBeenCalled();
        timer.runAll();
        await vi.waitFor(() => expect(controller.getSnapshot().initialInput).toBe("delivered"));
        timer.runAll();

        expect(fakes.write).toHaveBeenCalledTimes(1);
        expect(fakes.write).toHaveBeenCalledWith(42, "\x1b[200~Build it safely.\x1b[201~\r");
        expect(delivered).toHaveBeenCalledOnce();
    });

    it("does not retry an ambiguous failed initial-input write", async () => {
        const timer = new FakeTimer();
        const writeError = new Error("bridge response lost");
        const { fakes, errors, options } = controllerOptions({ initialInput: "run once", timer });
        fakes.write.mockRejectedValue(writeError);
        const controller = new PtyLifecycleController(options);

        await controller.start();
        timer.runAll();
        await vi.waitFor(() => expect(controller.getSnapshot().initialInput).toBe("failed"));
        await controller.start();
        timer.runAll();

        expect(fakes.write).toHaveBeenCalledTimes(1);
        expect(errors).toContainEqual({ operation: "initial-input", error: writeError });
    });
});

describe("PtyLifecycleController renderer subscriptions", () => {
    it("keeps atomic snapshot ordering across attach, activate, and detach", async () => {
        const attached = deferred<PtyAttachResult>();
        const { fakes, channels, options } = controllerOptions();
        fakes.attach.mockReturnValue(attached.promise);
        const controller = new PtyLifecycleController(options);
        const received: PtyOutputChunk[] = [];
        const attaching = controller.attach((chunk) => received.push(chunk));
        await vi.waitFor(() => expect(channels.bindings).toHaveLength(1));

        const beforeResponse = [3, 4];
        channels.bindings[0].emit(beforeResponse);
        attached.resolve({ subId: 9, snapshot: [1, 2], alternateScreen: true });
        const attachment = await attaching;
        const beforeActivate = [5, 6];
        channels.bindings[0].emit(beforeActivate);
        expect(received).toEqual([]);
        expect(attachment.snapshot).toEqual([1, 2]);
        expect(attachment.alternateScreen).toBe(true);

        attachment.activate();
        expect(received).toEqual([beforeResponse, beforeActivate]);
        const live = new Uint8Array([7, 8]);
        channels.bindings[0].emit(live);
        expect(received).toEqual([beforeResponse, beforeActivate, live]);

        const detaching = attachment.detach();
        expect(attachment.detach()).toBe(detaching);
        await detaching;
        channels.bindings[0].emit([9]);
        expect(received).toHaveLength(3);
        expect(fakes.detach).toHaveBeenCalledTimes(1);
        expect(fakes.detach).toHaveBeenCalledWith(42, 9);
        expect(fakes.kill).not.toHaveBeenCalled();
        expect(channels.bindings[0].close).toHaveBeenCalledOnce();
        expect(controller.getSnapshot()).toMatchObject({ status: "running", attachmentCount: 0 });
    });

    it("bounds pre-activation events and forces snapshot resynchronization", async () => {
        const attached = deferred<PtyAttachResult>();
        const { fakes, channels, errors, options } = controllerOptions({ maxPendingChunks: 2, maxPendingBytes: 4 });
        fakes.attach.mockReturnValue(attached.promise);
        const controller = new PtyLifecycleController(options);
        const received = vi.fn();
        const attaching = controller.attach(received);
        await vi.waitFor(() => expect(channels.bindings).toHaveLength(1));

        channels.bindings[0].emit([1, 2]);
        channels.bindings[0].emit([3, 4]);
        channels.bindings[0].emit([5]);
        attached.resolve({ subId: 10, snapshot: [], alternateScreen: false });

        await expect(attaching).rejects.toBeInstanceOf(PtySubscriptionOverflowError);
        expect(received).not.toHaveBeenCalled();
        expect(fakes.detach).toHaveBeenCalledTimes(1);
        expect(errors.some((event) => event.error instanceof PtySubscriptionOverflowError)).toBe(true);
        expect(controller.getSnapshot().attachmentCount).toBe(0);
    });

    it("bounds active chunks and total simultaneous attachments", async () => {
        const { fakes, channels, errors, options } = controllerOptions({ maxAttachments: 1, maxPendingBytes: 3 });
        const controller = new PtyLifecycleController(options);
        const listener = vi.fn();
        const attachment = await controller.attach(listener);
        attachment.activate();

        await expect(controller.attach(vi.fn())).rejects.toThrow("attachment limit");
        channels.bindings[0].emit([1, 2, 3, 4]);
        await vi.waitFor(() => expect(fakes.detach).toHaveBeenCalledOnce());

        expect(listener).not.toHaveBeenCalled();
        expect(fakes.attach).toHaveBeenCalledTimes(1);
        expect(errors.some((event) => event.error instanceof PtySubscriptionOverflowError)).toBe(true);
    });

    it("unsubscribes a valid native subscription when its snapshot is oversized", async () => {
        const { fakes, options } = controllerOptions({ maxSnapshotBytes: 2 });
        fakes.attach.mockResolvedValue({ subId: 23, snapshot: [1, 2, 3], alternateScreen: false });
        const controller = new PtyLifecycleController(options);

        await expect(controller.attach(vi.fn())).rejects.toThrow("oversized snapshot");
        expect(fakes.detach).toHaveBeenCalledOnce();
        expect(fakes.detach).toHaveBeenCalledWith(42, 23);
        expect(controller.getSnapshot()).toMatchObject({ status: "exited", attachmentCount: 0, failureOperation: "attach" });
    });

    it("contains listener failures and detaches after a bounded error budget", async () => {
        const { fakes, channels, errors, options } = controllerOptions({ maxListenerErrors: 2 });
        const controller = new PtyLifecycleController(options);
        const listenerError = new Error("renderer failed");
        const listener = vi.fn(() => {
            throw listenerError;
        });
        const attachment = await controller.attach(listener);
        attachment.activate();

        expect(() => channels.bindings[0].emit([1])).not.toThrow();
        expect(() => channels.bindings[0].emit([2])).not.toThrow();
        expect(() => channels.bindings[0].emit([3])).not.toThrow();
        await vi.waitFor(() => expect(fakes.detach).toHaveBeenCalledOnce());

        expect(listener).toHaveBeenCalledTimes(2);
        expect(errors.filter((event) => event.operation === "output-listener")).toHaveLength(2);
        expect(controller.getSnapshot().attachmentCount).toBe(0);
    });

    it("treats a zero-length native event as terminal exit", async () => {
        const { fakes, channels, options } = controllerOptions();
        const controller = new PtyLifecycleController(options);
        const listener = vi.fn();
        const attachment = await controller.attach(listener);
        attachment.activate();
        channels.bindings[0].emit([]);

        expect(listener).toHaveBeenCalledWith([]);
        expect(controller.getSnapshot()).toMatchObject({ status: "exited", failureOperation: "exit" });
        await expect(controller.write("ignored")).rejects.toBeInstanceOf(PtyControllerExitedError);
        await expect(controller.start()).rejects.toBeInstanceOf(PtyControllerExitedError);
        expect(fakes.spawn).toHaveBeenCalledOnce();
    });

    it("makes attach failure terminal so a fresh controller owns any restart", async () => {
        const attachError = Object.freeze({ category: "bad-argument", message: "pty not found" });
        const { fakes, errors, options } = controllerOptions();
        fakes.attach.mockRejectedValue(attachError);
        const controller = new PtyLifecycleController(options);

        await expect(controller.attach(vi.fn())).rejects.toBe(attachError);
        expect(controller.getSnapshot()).toMatchObject({ status: "exited", failureOperation: "attach", attachmentCount: 0 });
        await expect(controller.start()).rejects.toBeInstanceOf(PtyControllerExitedError);
        expect(errors).toContainEqual({ operation: "attach", error: attachError });
    });

    it("detaches subscriptions and kills once on repeated disposal", async () => {
        const { fakes, channels, options } = controllerOptions();
        const controller = new PtyLifecycleController(options);
        const first = await controller.attach(vi.fn());
        const second = await controller.attach(vi.fn());
        first.activate();
        second.activate();

        const disposing = controller.dispose();
        expect(controller.dispose()).toBe(disposing);
        await disposing;

        expect(fakes.detach).toHaveBeenCalledTimes(2);
        expect(fakes.kill).toHaveBeenCalledTimes(1);
        expect(channels.bindings.every((binding) => binding.close.mock.calls.length === 1)).toBe(true);
        expect(controller.getSnapshot()).toMatchObject({ status: "disposed", attachmentCount: 0 });
    });

    it("closes an in-flight attachment exactly once when disposal wins", async () => {
        const nativeAttach = deferred<PtyAttachResult>();
        const { fakes, channels, options } = controllerOptions();
        fakes.attach.mockReturnValue(nativeAttach.promise);
        const controller = new PtyLifecycleController(options);
        const attaching = controller.attach(vi.fn());
        await vi.waitFor(() => expect(channels.bindings).toHaveLength(1));
        const disposing = controller.dispose();
        nativeAttach.reject(new Error("killed while attaching"));

        await expect(attaching).rejects.toBeInstanceOf(PtyControllerDisposedError);
        await disposing;
        expect(channels.bindings[0].close).toHaveBeenCalledOnce();
        expect(fakes.kill).toHaveBeenCalledOnce();
        expect(fakes.detach).not.toHaveBeenCalled();
    });
});

describe("PtyLifecycleController safety boundaries", () => {
    it("exposes content-free runtime snapshots and rejects persistence", async () => {
        const timer = new FakeTimer();
        const { options } = controllerOptions({ initialInput: "secret first task", timer });
        const controller = new PtyLifecycleController(options);
        await controller.start();

        const snapshotText = JSON.stringify(controller.getSnapshot());
        expect(snapshotText).not.toContain("secret first task");
        expect(snapshotText).not.toContain("42");
        expect(() => JSON.stringify(controller)).toThrow("cannot be serialized");

        const attachment = await controller.attach(vi.fn());
        expect(() => JSON.stringify(attachment)).toThrow("cannot be serialized");
    });

    it("bounds state subscribers and removes listeners that throw", async () => {
        const observerError = new Error("observer failed");
        const { errors, options } = controllerOptions({ maxStateListeners: 1 });
        const controller = new PtyLifecycleController(options);
        const unsubscribe = controller.subscribe(() => {
            throw observerError;
        });
        unsubscribe();
        const listener = vi.fn();
        controller.subscribe(listener);
        expect(() => controller.subscribe(vi.fn())).toThrow(RangeError);

        await controller.start();
        expect(listener).toHaveBeenCalled();
        expect(errors).toContainEqual({ operation: "state-listener", error: observerError });
    });

    it("validates native dimensions before spawning", async () => {
        const { fakes, options } = controllerOptions();
        const controller = new PtyLifecycleController(options);

        await expect(controller.resize(0, 24)).rejects.toThrow(RangeError);
        await expect(controller.resize(80, 65_536)).rejects.toThrow(RangeError);
        expect(fakes.spawn).not.toHaveBeenCalled();
        expect(fakes.resize).not.toHaveBeenCalled();
    });
});

import { describe, expect, it, vi } from "vitest";
import type { ActiveProjectControllerSnapshot } from "./controllerRuntime";
import { ProjectControllerBridge, type ProjectControllerRuntimeLoader, type ProjectControllerRuntimePort } from "./controllerBridge";

function deferred<Value>() {
    let resolve!: (value: Value | PromiseLike<Value>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

class FakeRuntime implements ProjectControllerRuntimePort {
    private readonly listeners = new Set<() => void>();
    private snapshot: ActiveProjectControllerSnapshot | null = null;

    readonly subscribe = vi.fn((listener: () => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    });
    readonly getActiveSnapshot = vi.fn(() => this.snapshot);
    readonly start = vi.fn<() => Promise<void>>(() => Promise.resolve());
    readonly reconcile = vi.fn<(roots: readonly string[], activeRoot: string | null) => Promise<void>>(() => Promise.resolve());
    readonly refresh = vi.fn<(root?: string) => Promise<void>>(() => Promise.resolve());
    readonly stop = vi.fn<() => void>();

    publish(snapshot: ActiveProjectControllerSnapshot | null): void {
        this.snapshot = snapshot;
        for (const listener of this.listeners) listener();
    }
}

describe("ProjectControllerBridge", () => {
    it("retains desired reconciliation across lazy load and exposes a stable external-store snapshot", async () => {
        const pending = deferred<ProjectControllerRuntimePort>();
        const runtime = new FakeRuntime();
        const bridge = new ProjectControllerBridge(() => pending.promise);
        const changed = vi.fn();
        bridge.subscribe(changed);

        await bridge.reconcile(["/repo"], "/repo");
        await bridge.refresh("/repo");
        const starting = bridge.start();
        expect(runtime.start).not.toHaveBeenCalled();

        pending.resolve(runtime);
        await starting;
        expect(runtime.start).toHaveBeenCalledOnce();
        expect(runtime.reconcile).toHaveBeenCalledWith(["/repo"], "/repo");

        const snapshot = Object.freeze({ cwd: "/repo" }) as unknown as ActiveProjectControllerSnapshot;
        runtime.publish(snapshot);
        expect(bridge.getActiveSnapshot()).toBe(snapshot);
        expect(changed).toHaveBeenCalledOnce();
        await bridge.refresh("/repo");
        expect(runtime.refresh).toHaveBeenCalledWith("/repo");

        bridge.stop();
        expect(runtime.stop).toHaveBeenCalledOnce();
        expect(bridge.getActiveSnapshot()).toBeNull();
        expect(changed).toHaveBeenCalledTimes(2);
    });

    it("ignores a stale StrictMode activation without stopping its replacement", async () => {
        const firstStart = deferred<void>();
        const runtime = new FakeRuntime();
        runtime.start.mockImplementationOnce(() => firstStart.promise).mockResolvedValueOnce(undefined);
        const bridge = new ProjectControllerBridge(() => Promise.resolve(runtime));

        await bridge.reconcile(["/old"], "/old");
        const staleStart = bridge.start();
        await vi.waitFor(() => expect(runtime.start).toHaveBeenCalledOnce());

        bridge.stop();
        await bridge.start();
        expect(runtime.start).toHaveBeenCalledTimes(2);
        expect(runtime.reconcile).toHaveBeenCalledTimes(1);
        expect(runtime.reconcile).toHaveBeenLastCalledWith(["/old"], "/old");

        firstStart.resolve();
        await staleStart;
        expect(runtime.stop).toHaveBeenCalledOnce();
        expect(runtime.reconcile).toHaveBeenCalledTimes(1);
    });

    it("contains a failed load and retries with the retained desired roots", async () => {
        const runtime = new FakeRuntime();
        const loader = vi.fn<ProjectControllerRuntimeLoader>().mockRejectedValueOnce(new Error("chunk unavailable")).mockResolvedValueOnce(runtime);
        const bridge = new ProjectControllerBridge(loader);

        await bridge.reconcile(["/repo"], "/repo");
        await expect(bridge.start()).resolves.toBeUndefined();
        await expect(bridge.start()).resolves.toBeUndefined();

        expect(loader).toHaveBeenCalledTimes(2);
        expect(runtime.reconcile).toHaveBeenCalledWith(["/repo"], "/repo");
    });
});

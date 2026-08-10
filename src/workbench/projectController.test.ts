import { beforeEach, describe, expect, it, vi } from "vitest";
import { performanceTelemetry } from "../lib/performance";
import { ProjectController, ProjectControllerRegistry, type ProjectControllerServices } from "./projectController";

type Config = { name: string };
type Worktree = { path: string };

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function services() {
    const api = {
        loadConfig: vi.fn<(cwd: string) => Promise<Config>>().mockResolvedValue({ name: "repo" }),
        loadWorktrees: vi.fn<(cwd: string) => Promise<readonly Worktree[]>>().mockResolvedValue([{ path: "/repo" }]),
        watchStart: vi.fn<(cwd: string) => void>(),
        watchStop: vi.fn<(cwd: string) => void>(),
    } satisfies ProjectControllerServices<Config, Worktree>;
    return api;
}

beforeEach(() => performanceTelemetry.reset());

describe("ProjectController", () => {
    it("starts shared services once and stops them after the final release", async () => {
        const api = services();
        const registry = new ProjectControllerRegistry(api);
        const first = registry.acquire("/repo");
        const second = registry.acquire("/repo");
        expect(second.controller).toBe(first.controller);
        await first.ready;

        expect(api.watchStart).toHaveBeenCalledTimes(1);
        expect(first.controller.getSnapshot()).toMatchObject({ status: "ready", retainCount: 2, revision: 1 });
        first.release();
        first.release();
        expect(api.watchStop).not.toHaveBeenCalled();
        second.release();
        expect(api.watchStop).toHaveBeenCalledTimes(1);
    });

    it("coalesces refresh bursts and ignores stale work after release", async () => {
        const config = deferred<Config>();
        const worktrees = deferred<readonly Worktree[]>();
        const api = services();
        api.loadConfig.mockReturnValueOnce(config.promise);
        api.loadWorktrees.mockReturnValueOnce(worktrees.promise);
        const controller = new ProjectController("/repo", api);
        const first = controller.retain();
        const second = controller.refresh();
        expect(second).toBe(first);

        controller.release();
        config.resolve({ name: "stale" });
        worktrees.resolve([{ path: "/stale" }]);
        await first;

        expect(controller.getSnapshot()).toMatchObject({ retainCount: 0, config: null, worktrees: [] });
        expect(api.loadConfig).toHaveBeenCalledTimes(1);
    });

    it("queues a fresh generation when released and reacquired before stale work settles", async () => {
        const staleConfig = deferred<Config>();
        const staleWorktrees = deferred<readonly Worktree[]>();
        const freshConfig = deferred<Config>();
        const freshWorktrees = deferred<readonly Worktree[]>();
        const freshStarted = deferred<void>();
        const api = services();
        api.loadConfig
            .mockReset()
            .mockReturnValueOnce(staleConfig.promise)
            .mockImplementationOnce(() => {
                freshStarted.resolve(undefined);
                return freshConfig.promise;
            });
        api.loadWorktrees.mockReset().mockReturnValueOnce(staleWorktrees.promise).mockReturnValueOnce(freshWorktrees.promise);
        const controller = new ProjectController("/repo", api);

        const firstReady = controller.retain();
        controller.release();
        const reacquiredReady = controller.retain();

        expect(reacquiredReady).toBe(firstReady);
        expect(api.watchStart).toHaveBeenCalledTimes(2);
        expect(api.watchStop).toHaveBeenCalledTimes(1);
        expect(controller.getSnapshot()).toMatchObject({ status: "loading", retainCount: 1, config: null, worktrees: [] });

        staleConfig.resolve({ name: "stale" });
        staleWorktrees.resolve([{ path: "/stale" }]);
        await freshStarted.promise;

        expect(api.loadConfig).toHaveBeenCalledTimes(2);
        expect(api.loadWorktrees).toHaveBeenCalledTimes(2);
        expect(controller.getSnapshot()).toMatchObject({ status: "loading", retainCount: 1, config: null, worktrees: [], revision: 0 });
        freshConfig.resolve({ name: "fresh" });
        freshWorktrees.resolve([{ path: "/fresh" }]);
        await reacquiredReady;

        expect(controller.getSnapshot()).toMatchObject({
            status: "ready",
            retainCount: 1,
            config: { name: "fresh" },
            worktrees: [{ path: "/fresh" }],
            revision: 1,
        });
        expect(performanceTelemetry.snapshot().counters).toMatchObject({
            "project.refresh.queued": 1,
            "project.refresh.cancelled": 1,
        });
        expect(performanceTelemetry.snapshot().latencies["project.refresh"].count).toBe(2);
    });

    it("disposal cancels queued replacement work and ignores the in-flight result", async () => {
        const config = deferred<Config>();
        const worktrees = deferred<readonly Worktree[]>();
        const api = services();
        api.loadConfig.mockReturnValueOnce(config.promise);
        api.loadWorktrees.mockReturnValueOnce(worktrees.promise);
        const controller = new ProjectController("/repo", api);

        const ready = controller.retain();
        expect(controller.refresh()).toBe(ready);
        controller.dispose();
        controller.dispose();
        config.resolve({ name: "late" });
        worktrees.resolve([{ path: "/late" }]);
        await ready;

        expect(api.loadConfig).toHaveBeenCalledTimes(1);
        expect(api.loadWorktrees).toHaveBeenCalledTimes(1);
        expect(api.watchStop).toHaveBeenCalledTimes(1);
        expect(controller.getSnapshot()).toMatchObject({ status: "idle", retainCount: 0, config: null, worktrees: [], revision: 0 });
        expect(performanceTelemetry.snapshot().counters).toMatchObject({
            "project.refresh.queued": 1,
            "project.refresh.cancelled": 1,
        });
        await expect(controller.refresh()).resolves.toBeUndefined();
        expect(() => controller.retain()).toThrow("disposed");
    });

    it("publishes immutable snapshots and disposes idempotently", async () => {
        const api = services();
        const controller = new ProjectController("/repo", api);
        const listener = vi.fn();
        controller.subscribe(listener);
        await controller.retain();
        const snapshot = controller.getSnapshot();
        expect(snapshot.config).toEqual({ name: "repo" });
        expect(listener).toHaveBeenCalled();
        expect(performanceTelemetry.snapshot().latencies["project.refresh"].count).toBe(1);

        controller.dispose();
        controller.dispose();
        expect(api.watchStop).toHaveBeenCalledTimes(1);
        expect(() => controller.retain()).toThrow("disposed");
    });
});

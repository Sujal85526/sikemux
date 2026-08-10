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

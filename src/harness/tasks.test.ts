import { describe, expect, it, vi } from "vitest";
import { HarnessTasks, type HarnessLaunchRequest } from "./tasks";
import { HarnessEvents } from "./events";
import type { TaskProcessExit } from "../tasks/runtime";

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}
function fixture() {
    const exits: ReturnType<typeof deferred<TaskProcessExit>>[] = [];
    const backend = {
        start: vi.fn(() => {
            const completion = deferred<TaskProcessExit>();
            exits.push(completion);
            return { ptyId: exits.length, completion: completion.promise };
        }),
        stop: vi.fn(async () => {}),
    };
    const surface = { open: vi.fn(async () => {}) };
    const events = new HarnessEvents();
    return { tasks: new HarnessTasks(backend, surface, events), backend, surface, events, exits };
}
const request: HarnessLaunchRequest = {
    taskId: "dev",
    label: "Dev",
    project: "/one",
    source: "project",
    command: "echo test",
    cwd: "/one",
    env: {},
    cols: 80,
    rows: 24,
};

function start(tasks: HarnessTasks, launch: HarnessLaunchRequest, key: string, agentId?: string) {
    return tasks.start(launch.project, launch.taskId, key, () => ({ request: launch }), { agentId }).started;
}

describe("managed harness tasks", () => {
    it("deduplicates concurrent launches and retries, including aliases after completion", async () => {
        const { tasks, backend, exits } = fixture();
        const [first, retry, alias] = await Promise.all([start(tasks, request, "key"), start(tasks, request, "key"), start(tasks, request, "alias")]);
        expect(backend.start).toHaveBeenCalledOnce();
        expect(retry.executionId).toBe(first.executionId);
        expect(alias.executionId).toBe(first.executionId);
        exits[0].resolve({ code: 0 });
        await Promise.resolve();
        expect((await start(tasks, request, "alias")).status).toBe("completed");
        expect(() => start(tasks, { ...request, taskId: "other" }, "key")).toThrow("another task");
    });
    it("stops only the requested generation and keeps independent tasks running", async () => {
        const { tasks, backend, exits } = fixture();
        const first = await start(tasks, request, "one");
        exits[0].resolve({ code: 0 });
        await Promise.resolve();
        const second = await start(tasks, request, "two");
        await tasks.stop("/one", first.executionId);
        expect(backend.stop).not.toHaveBeenCalled();
        await Promise.all([tasks.stop("/one", second.executionId), tasks.stop("/one", second.executionId)]);
        expect(backend.stop).toHaveBeenCalledExactlyOnceWith(2);
        expect(tasks.get("/one", second.executionId).status).toBe("stopped");
        expect(() => tasks.get("/two", second.executionId)).toThrow("does not belong");
    });
    it("stops the tasks a closed agent started and leaves other agents' running", async () => {
        const { tasks, backend } = fixture();
        const mine = await start(tasks, request, "mine", "agent-1");
        const theirs = await start(tasks, { ...request, taskId: "test" }, "theirs", "agent-2");
        tasks.closeAgent("agent-1");
        await vi.waitFor(() => expect(tasks.get("/one", mine.executionId).status).toBe("stopped"));
        expect(backend.stop).toHaveBeenCalledExactlyOnceWith(mine.ptyId);
        expect(tasks.get("/one", theirs.executionId).status).toBe("running");
    });
    it("preserves failure exit codes and produces output/lifecycle events", async () => {
        const { tasks, events, exits } = fixture();
        const cursor = events.cursor;
        const run = await start(tasks, request, "key");
        tasks.output(run.ptyId!);
        exits[0].resolve({ code: 7 });
        await Promise.resolve();
        expect(tasks.get("/one", run.executionId)).toMatchObject({ status: "failed", exitCode: 7 });
        expect((await events.wait("/one", cursor, 0)).events.map((event) => event.kind)).toEqual([
            "task.starting",
            "task.running",
            "task.output",
            "task.failed",
        ]);
    });
    it("cleans up failed presentation and allows retrying a failed stop", async () => {
        const { tasks, backend, surface } = fixture();
        surface.open.mockRejectedValueOnce(new Error("pane closed"));
        await expect(start(tasks, request, "bad")).rejects.toThrow("pane closed");
        expect(backend.stop).toHaveBeenCalledWith(1);
        const run = await start(tasks, request, "good");
        backend.stop.mockRejectedValueOnce(new Error("stop failed"));
        await expect(tasks.stop("/one", run.executionId)).rejects.toThrow("stop failed");
        expect((await tasks.stop("/one", run.executionId)).status).toBe("stopped");
    });
    it("waits for pending launch before stopping its exact PTY", async () => {
        const started = deferred<{ ptyId: number; completion: Promise<TaskProcessExit> }>();
        const backend = { start: vi.fn(() => started.promise), stop: vi.fn(async () => {}) };
        const tasks = new HarnessTasks(backend, { open: async () => {} }, new HarnessEvents());
        const launch = start(tasks, request, "key");
        const run = tasks.list("/one")[0];
        await vi.waitFor(() => expect(backend.start).toHaveBeenCalled());
        const stop = tasks.stop("/one", run.executionId);
        expect(backend.stop).not.toHaveBeenCalled();
        started.resolve({ ptyId: 71, completion: new Promise(() => {}) });
        await launch;
        await stop;
        expect(backend.stop).toHaveBeenCalledExactlyOnceWith(71);
    });
    it("shows a run waiting on trust at once and cancels it without launching when stopped", async () => {
        const { tasks, backend, events } = fixture();
        const cursor = events.cursor;
        const trust = deferred<boolean>();
        const launch = tasks.start("/one", "dev", "key", async (executionId) => {
            tasks.awaitTrust("/one", executionId);
            await trust.promise;
            return { request };
        });
        expect(tasks.latest("/one", "dev")).toMatchObject({ executionId: launch.executionId, status: "awaiting-trust" });
        expect(tasks.existing("/one", "dev", "key")?.executionId).toBe(launch.executionId);
        expect((await tasks.stop("/one", launch.executionId)).status).toBe("stopped");
        trust.resolve(true);
        expect((await launch.started).status).toBe("stopped");
        expect(backend.start).not.toHaveBeenCalled();
        expect((await events.wait("/one", cursor, 0)).events.map((event) => event.kind)).toEqual([
            "task.starting",
            "task.awaiting-trust",
            "task.stopped",
        ]);
    });
    it("records a refused launch as a failed run and lets a replacement start beside an active one", async () => {
        const { tasks, backend } = fixture();
        const refused = tasks.start("/one", "dev", "no", () => Promise.reject(new Error("Project configuration was not approved")));
        await expect(refused.started).rejects.toThrow("not approved");
        expect(tasks.get("/one", refused.executionId)).toMatchObject({ status: "failed", error: "Project configuration was not approved" });
        const first = await start(tasks, request, "one");
        const second = await tasks.start("/one", "dev", "two", () => ({ request }), { replace: true }).started;
        expect(second.executionId).not.toBe(first.executionId);
        expect(backend.start).toHaveBeenCalledTimes(2);
        expect(tasks.latest("/one", "dev")).toMatchObject({ executionId: second.executionId, label: "Dev", command: "echo test" });
    });
    it("knows which tasks were started before the window reloaded", async () => {
        const stored = new Map<string, string>();
        const history = { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => void stored.set(key, value) };
        const backend = { start: vi.fn(() => ({ ptyId: 1, completion: new Promise<TaskProcessExit>(() => {}) })), stop: vi.fn(async () => {}) };
        const before = new HarnessTasks(backend, { open: async () => {} }, new HarnessEvents(), history);
        await start(before, request, "key");
        expect(before.startedEarlier("/one", "dev")).toBe(false);
        const after = new HarnessTasks(backend, { open: async () => {} }, new HarnessEvents(), history);
        expect(after.startedEarlier("/one", "dev")).toBe(true);
        expect(after.startedEarlier("/one", "other")).toBe(false);
        expect(after.startedEarlier("/two", "dev")).toBe(false);
        await start(after, request, "key");
        expect(after.startedEarlier("/one", "dev")).toBe(false);
    });
    it("takes back a run the core kept, quietly, so it can be read, stopped and found by task id", async () => {
        const { tasks, backend, surface } = fixture();
        const exit = deferred<TaskProcessExit>();
        tasks.adopt(
            { executionId: "kept", terminalKey: JSON.stringify(["harness", "/one", "dev"]), request, agentId: "agent-1", running: true },
            { ptyId: 77, completion: exit.promise },
        );
        expect(tasks.latest("/one", "dev")).toMatchObject({ executionId: "kept", status: "running", ptyId: 77, command: "echo test" });
        expect(surface.open).toHaveBeenCalledWith(expect.objectContaining({ ptyId: 77, agentId: "agent-1", background: true }));
        expect(tasks.startedEarlier("/one", "dev")).toBe(false);
        expect(tasks.launchRequest("/one", "dev")).toEqual(request);

        await expect(tasks.stop("/one", "kept")).resolves.toMatchObject({ status: "stopped" });
        expect(backend.stop).toHaveBeenCalledWith(77);
        expect(backend.start).not.toHaveBeenCalled();
    });

    it("takes back a run that ended while the app was closed without opening its terminal", async () => {
        const { tasks, surface } = fixture();
        tasks.adopt(
            { executionId: "done", terminalKey: JSON.stringify(["harness", "/one", "dev"]), request, running: false },
            { ptyId: 5, completion: Promise.resolve({ code: 2 }) },
        );
        await Promise.resolve();
        await Promise.resolve();
        expect(tasks.get("/one", "done")).toMatchObject({ status: "failed", exitCode: 2 });
        expect(surface.open).not.toHaveBeenCalled();
    });
});

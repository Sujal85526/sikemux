import { describe, expect, it, vi } from "vitest";
import { LSP_PAYLOAD_LIMITS, type LspDiagnostic, type LspDiagnosticsListener, type LspDiagnosticsPayload } from "../api/lsp";
import {
    PROJECT_DIAGNOSTICS_RUNTIME_LIMITS,
    ProjectDiagnosticsRuntime,
    ProjectDiagnosticsRuntimeDisposedError,
    type ProjectDiagnosticsSourceSubscribe,
} from "./projectDiagnostics";

function diagnostic(message: string): LspDiagnostic {
    return {
        range: {
            start: { line: 1, character: 2 },
            end: { line: 1, character: 3 },
        },
        severity: "warning",
        code: null,
        source: "test",
        message,
    };
}

function payload(project: string, message: string, overrides: Partial<LspDiagnosticsPayload> = {}): LspDiagnosticsPayload {
    return {
        project,
        language: "typescript",
        path: `${project}/src/main.ts`,
        version: 1,
        diagnostics: [diagnostic(message)],
        ...overrides,
    };
}

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

describe("ProjectDiagnosticsRuntime ownership", () => {
    it("shares one native listener and ref-counts one controller per project", async () => {
        const deliveries: LspDiagnosticsListener[] = [];
        const unsubscribe = vi.fn();
        const source = vi.fn<ProjectDiagnosticsSourceSubscribe>((listener) => {
            deliveries.push(listener);
            return unsubscribe;
        });
        const runtime = new ProjectDiagnosticsRuntime(source);

        const first = runtime.acquire("/repo/a");
        const second = runtime.acquire("/repo/a");
        const other = runtime.acquire("/repo/b");

        expect(first.controller).toBe(second.controller);
        expect(other.controller).not.toBe(first.controller);
        expect(source).toHaveBeenCalledOnce();
        expect(deliveries).toHaveLength(1);
        await Promise.all([first.ready, second.ready, other.ready]);

        first.release();
        first.release();
        expect(first.released).toBe(true);
        expect(second.getSnapshot().disposed).toBe(false);
        expect(unsubscribe).not.toHaveBeenCalled();

        second.release();
        expect(second.released).toBe(true);
        expect(first.getSnapshot().disposed).toBe(true);
        expect(other.getSnapshot().disposed).toBe(false);
        expect(unsubscribe).not.toHaveBeenCalled();

        other.release();
        other.release();
        expect(other.getSnapshot().disposed).toBe(true);
        expect(unsubscribe).toHaveBeenCalledOnce();
    });

    it("assigns increasing generations to language lifecycles and routes exact projects", async () => {
        const deliveries: LspDiagnosticsListener[] = [];
        const runtime = new ProjectDiagnosticsRuntime((listener) => {
            deliveries.push(listener);
            return () => {};
        });
        const first = runtime.acquire("/repo/a");
        const second = runtime.acquire("/repo/b");
        await Promise.all([first.ready, second.ready]);

        const firstTypeScript = runtime.noteServerStarted("/repo/a", "typescript");
        expect(firstTypeScript).toBe(1);
        expect(runtime.noteServerStarted("/repo/a", "typescript")).toBe(firstTypeScript);
        expect(runtime.noteServerStarted("/repo/b", "typescript")).toBe(2);
        expect(runtime.noteServerStarted("/repo/a", "eslint")).toBe(3);
        expect(runtime.noteServerStarted("/not-acquired", "typescript")).toBeNull();

        deliveries[0](payload("/repo/a", "a typescript"));
        deliveries[0](payload("/repo/b", "b typescript"));
        deliveries[0](payload("/repo/a", "a eslint", { language: "eslint" }));
        deliveries[0](payload("/repo/a", "inactive language", { language: "rust" }));
        deliveries[0](payload("/not-acquired", "unknown project"));

        expect(first.controller.selectProblems().map(({ message }) => message)).toEqual(["a eslint", "a typescript"]);
        expect(second.controller.selectProblems().map(({ message }) => message)).toEqual(["b typescript"]);
        expect(first.controller.selectProblems().map(({ serverGeneration }) => serverGeneration)).toEqual([3, 1]);

        expect(runtime.noteServerStopped("/repo/a", "typescript")).toBe(true);
        expect(runtime.noteServerStopped("/repo/a", "typescript")).toBe(false);
        deliveries[0](payload("/repo/a", "late stopped payload", { version: 2 }));
        expect(first.controller.selectProblems().map(({ message }) => message)).toEqual(["a eslint"]);

        const restarted = runtime.noteServerStarted("/repo/a", "typescript");
        expect(restarted).toBe(4);
        expect(restarted).toBeGreaterThan(firstTypeScript ?? 0);
        deliveries[0](payload("/repo/a", "restarted", { version: 2 }));
        expect(first.controller.selectDocument("/repo/a/src/main.ts").map(({ message }) => message)).toEqual(["a eslint", "restarted"]);

        first.release();
        second.release();

        const reacquired = runtime.acquire("/repo/a");
        await reacquired.ready;
        expect(runtime.noteServerStarted("/repo/a", "typescript")).toBe(5);
        reacquired.release();
    });

    it("provides stable snapshots and isolates failing external-store subscribers", async () => {
        const deliveries: LspDiagnosticsListener[] = [];
        const runtime = new ProjectDiagnosticsRuntime(
            (listener) => {
                deliveries.push(listener);
                return () => {};
            },
            { maxSubscribersPerProject: 2 },
        );
        const lease = runtime.acquire("/repo");
        await lease.ready;

        const initial = lease.getSnapshot();
        expect(lease.getSnapshot()).toBe(initial);
        expect(Object.isFrozen(initial)).toBe(true);

        const healthy = vi.fn();
        const broken = vi.fn(() => {
            throw new Error("render failed");
        });
        const unsubscribeHealthy = lease.subscribe(healthy);
        lease.subscribe(broken);

        runtime.noteServerStarted("/repo", "typescript");
        expect(healthy).toHaveBeenCalledOnce();
        expect(broken).toHaveBeenCalledOnce();
        const active = lease.getSnapshot();
        expect(active).not.toBe(initial);
        expect(lease.getSnapshot()).toBe(active);

        const replacement = vi.fn();
        const unsubscribeReplacement = lease.subscribe(replacement);
        deliveries[0](payload("/repo", "problem"));
        expect(healthy).toHaveBeenCalledTimes(2);
        expect(replacement).toHaveBeenCalledOnce();
        expect(broken).toHaveBeenCalledOnce();
        const populated = lease.getSnapshot();
        expect(populated).toMatchObject({ activeServers: 1, documents: 1, problems: 1, disposed: false });
        expect(lease.getSnapshot()).toBe(populated);

        unsubscribeHealthy();
        unsubscribeHealthy();
        unsubscribeReplacement();
        lease.release();
        expect(lease.released).toBe(true);
        expect(lease.getSnapshot()).toMatchObject({ activeServers: 0, documents: 0, problems: 0, disposed: true });
        expect(() => lease.subscribe(() => {})).toThrow(/released/);
    });

    it("bounds projects, references, subscribers, and lifecycle identifiers", async () => {
        const inertSource: ProjectDiagnosticsSourceSubscribe = () => () => {};
        expect(() => new ProjectDiagnosticsRuntime(inertSource, { maxProjects: 0 })).toThrow(RangeError);
        expect(
            () =>
                new ProjectDiagnosticsRuntime(inertSource, {
                    maxProjects: PROJECT_DIAGNOSTICS_RUNTIME_LIMITS.maxProjects + 1,
                }),
        ).toThrow(RangeError);
        expect(() => new ProjectDiagnosticsRuntime(inertSource, { maxReferencesPerProject: 1.5 })).toThrow(RangeError);
        expect(() => new ProjectDiagnosticsRuntime(inertSource, { maxSubscribersPerProject: Number.NaN })).toThrow(RangeError);

        const runtime = new ProjectDiagnosticsRuntime(inertSource, {
            maxProjects: 1,
            maxReferencesPerProject: 2,
            maxSubscribersPerProject: 2,
        });
        expect(() => runtime.acquire(" ")).toThrow(TypeError);
        expect(() => runtime.acquire("/repo\nunsafe")).toThrow(TypeError);
        expect(() => runtime.acquire("x".repeat(LSP_PAYLOAD_LIMITS.maxPathBytes + 1))).toThrow(TypeError);

        const first = runtime.acquire("/repo");
        const second = runtime.acquire("/repo");
        await first.ready;
        expect(() => runtime.acquire("/repo")).toThrow(RangeError);
        expect(() => runtime.acquire("/other")).toThrow(RangeError);
        expect(() => runtime.noteServerStarted("/repo", " typescript")).toThrow(TypeError);
        expect(() => runtime.noteServerStarted("/repo", "typescript\0unsafe")).toThrow(TypeError);
        expect(() => runtime.noteServerStopped("/repo\nunsafe", "typescript")).toThrow(TypeError);

        const unsubscribeFirst = first.subscribe(() => {});
        const unsubscribeSecond = second.subscribe(() => {});
        expect(() => first.subscribe(() => {})).toThrow(RangeError);
        expect(() => first.subscribe(null as unknown as () => void)).toThrow(TypeError);

        unsubscribeFirst();
        unsubscribeSecond();
        first.release();
        second.release();
    });
});

describe("ProjectDiagnosticsRuntime asynchronous source lifecycle", () => {
    it("invalidates a pending listener and permits immediate reacquisition", async () => {
        const firstSubscription = deferred<() => void>();
        const secondSubscription = deferred<() => void>();
        const deliveries: LspDiagnosticsListener[] = [];
        let invocation = 0;
        const source = vi.fn<ProjectDiagnosticsSourceSubscribe>((listener) => {
            deliveries.push(listener);
            invocation += 1;
            return invocation === 1 ? firstSubscription.promise : secondSubscription.promise;
        });
        const runtime = new ProjectDiagnosticsRuntime(source);

        const stale = runtime.acquire("/repo/stale");
        stale.release();
        const current = runtime.acquire("/repo/current");
        expect(source).toHaveBeenCalledTimes(2);

        const unsubscribeCurrent = vi.fn();
        secondSubscription.resolve(unsubscribeCurrent);
        await current.ready;
        runtime.noteServerStarted("/repo/current", "typescript");

        deliveries[0](payload("/repo/current", "from stale listener"));
        expect(current.controller.selectProblems()).toEqual([]);
        deliveries[1](payload("/repo/current", "from current listener"));
        expect(current.controller.selectProblems().map(({ message }) => message)).toEqual(["from current listener"]);

        const unsubscribeStale = vi.fn();
        firstSubscription.resolve(unsubscribeStale);
        await stale.ready;
        expect(unsubscribeStale).toHaveBeenCalledOnce();
        expect(unsubscribeCurrent).not.toHaveBeenCalled();

        current.release();
        expect(unsubscribeCurrent).toHaveBeenCalledOnce();
    });

    it("preserves subscription failures while allowing a later acquire to retry", async () => {
        const failure = new Error("listen rejected");
        const unsubscribe = vi.fn();
        let invocation = 0;
        const source = vi.fn<ProjectDiagnosticsSourceSubscribe>(() => {
            invocation += 1;
            if (invocation === 1) return Promise.reject(failure);
            return unsubscribe;
        });
        const runtime = new ProjectDiagnosticsRuntime(source);

        const first = runtime.acquire("/repo");
        await expect(first.ready).rejects.toBe(failure);

        const retry = runtime.acquire("/repo");
        await expect(retry.ready).resolves.toBeUndefined();
        expect(source).toHaveBeenCalledTimes(2);
        first.release();
        expect(unsubscribe).not.toHaveBeenCalled();
        retry.release();
        expect(unsubscribe).toHaveBeenCalledOnce();

        const synchronousFailure = new Error("listen threw");
        const synchronous = new ProjectDiagnosticsRuntime(() => {
            throw synchronousFailure;
        });
        const failedLease = synchronous.acquire("/sync");
        await expect(failedLease.ready).rejects.toBe(synchronousFailure);
        failedLease.release();
    });

    it("disposes during startup and contains late or throwing teardown", async () => {
        const subscription = deferred<() => void>();
        let delivery: LspDiagnosticsListener | undefined;
        const runtime = new ProjectDiagnosticsRuntime((listener) => {
            delivery = listener;
            return subscription.promise;
        });
        const lease = runtime.acquire("/repo");
        const snapshotListener = vi.fn();
        lease.subscribe(snapshotListener);
        runtime.noteServerStarted("/repo", "typescript");
        snapshotListener.mockClear();

        runtime.dispose();
        runtime.dispose();
        expect(lease.released).toBe(true);
        expect(lease.getSnapshot()).toMatchObject({ activeServers: 0, problems: 0, disposed: true });
        expect(snapshotListener).toHaveBeenCalledOnce();
        expect(runtime.noteServerStarted("/repo", "typescript")).toBeNull();
        expect(runtime.noteServerStopped("/repo", "typescript")).toBe(false);
        expect(() => runtime.acquire("/repo")).toThrow(ProjectDiagnosticsRuntimeDisposedError);

        delivery?.(payload("/repo", "late payload"));
        expect(lease.controller.selectProblems()).toEqual([]);
        const unsubscribe = vi.fn(() => {
            throw new Error("native teardown failed");
        });
        subscription.resolve(unsubscribe);
        await expect(lease.ready).resolves.toBeUndefined();
        expect(unsubscribe).toHaveBeenCalledOnce();
        lease.release();
        lease.release();
    });

    it("contains malformed runtime bypasses without poisoning later delivery", async () => {
        let delivery: LspDiagnosticsListener | undefined;
        const runtime = new ProjectDiagnosticsRuntime((listener) => {
            delivery = listener;
            return () => {};
        });
        const lease = runtime.acquire("/repo");
        await lease.ready;
        runtime.noteServerStarted("/repo", "typescript");

        const poisoned = Object.defineProperty({}, "project", {
            get() {
                throw new Error("unsafe getter");
            },
        }) as LspDiagnosticsPayload;
        expect(() => delivery?.(poisoned)).not.toThrow();
        delivery?.({ ...payload("/repo", "malformed"), diagnostics: [{ message: "missing range" }] } as unknown as LspDiagnosticsPayload);
        expect(lease.controller.selectProblems()).toEqual([]);

        delivery?.(payload("/repo", "valid afterward"));
        expect(lease.controller.selectProblems().map(({ message }) => message)).toEqual(["valid afterward"]);
        lease.release();
    });
});

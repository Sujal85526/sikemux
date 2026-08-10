import { afterEach, describe, expect, it, vi } from "vitest";
import { createItemId } from "./registry";
import {
    captureWorkbenchItemRuntimeLease,
    claimWorkbenchItemRuntime,
    closeWorkbenchItemRuntime,
    disposeWorkbenchItemRuntime,
    getOrCreateWorkbenchItemResource,
    resetWorkbenchItemRuntimeForTests,
    WorkbenchItemRuntimeLeaseError,
    workbenchItemRuntimeSnapshot,
} from "./itemRuntime";

afterEach(() => resetWorkbenchItemRuntimeForTests());

describe("workbench item runtime ownership", () => {
    it("creates once across renderer leases and disposes in reverse order", async () => {
        const itemId = createItemId("pane-runtime");
        const lease = claimWorkbenchItemRuntime(itemId);
        const events: string[] = [];
        const first = { runtime: "pty" };
        const createFirst = vi.fn(() => ({
            value: first,
            dispose: () => {
                events.push("first");
            },
        }));

        expect(captureWorkbenchItemRuntimeLease(itemId)).toBe(lease);
        expect(getOrCreateWorkbenchItemResource(lease, "core.terminal", "pty:v1", createFirst)).toBe(first);
        expect(getOrCreateWorkbenchItemResource(lease, "core.terminal", "pty:v1", createFirst)).toBe(first);
        getOrCreateWorkbenchItemResource(lease, "core.tracing", "trace:v1", () => ({
            value: { trace: true },
            dispose: async () => {
                events.push("second");
            },
        }));
        expect(createFirst).toHaveBeenCalledOnce();
        expect(workbenchItemRuntimeSnapshot()).toEqual({ items: 1, retiringItems: 0, resources: 2, pendingDisposals: 0 });

        const disposing = disposeWorkbenchItemRuntime(lease);
        expect(workbenchItemRuntimeSnapshot()).toMatchObject({ items: 0, retiringItems: 1, resources: 0 });
        await disposing;
        expect(events).toEqual(["second", "first"]);
        await disposeWorkbenchItemRuntime(lease);
        expect(events).toEqual(["second", "first"]);
    });

    it("closes acquisition synchronously and rejects late renderer claims", async () => {
        const itemId = createItemId("pane-late-renderer");
        const oldLease = claimWorkbenchItemRuntime(itemId);
        const disposed = vi.fn();
        getOrCreateWorkbenchItemResource(oldLease, "core.terminal", "old", () => ({ value: "old", dispose: disposed }));

        expect(closeWorkbenchItemRuntime(oldLease)).toBe(true);
        expect(captureWorkbenchItemRuntimeLease(itemId)).toBeNull();
        expect(() => getOrCreateWorkbenchItemResource(oldLease, "core.late", "late", () => ({ value: "orphan", dispose: () => {} }))).toThrow(
            WorkbenchItemRuntimeLeaseError,
        );

        const replacementLease = claimWorkbenchItemRuntime(itemId);
        expect(replacementLease.generation).toBeGreaterThan(oldLease.generation);
        expect(getOrCreateWorkbenchItemResource(replacementLease, "core.terminal", "new", () => ({ value: "new", dispose: () => {} }))).toBe("new");
        expect(() => getOrCreateWorkbenchItemResource(oldLease, "core.terminal", "old", () => ({ value: "orphan", dispose: () => {} }))).toThrow(
            WorkbenchItemRuntimeLeaseError,
        );

        await disposeWorkbenchItemRuntime(oldLease);
        expect(disposed).toHaveBeenCalledOnce();
        expect(captureWorkbenchItemRuntimeLease(itemId)).toBe(replacementLease);
    });

    it("replaces a resource when its launch fingerprint changes", async () => {
        const lease = claimWorkbenchItemRuntime(createItemId("pane-config"));
        const disposed: string[] = [];
        const oldValue = getOrCreateWorkbenchItemResource(lease, "core.terminal", "cwd:/old", () => ({
            value: { cwd: "/old" },
            dispose: () => {
                disposed.push("old");
            },
        }));
        const newValue = getOrCreateWorkbenchItemResource(lease, "core.terminal", "cwd:/new", () => ({
            value: { cwd: "/new" },
            dispose: () => {
                disposed.push("new");
            },
        }));

        expect(newValue).not.toBe(oldValue);
        await Promise.resolve();
        expect(disposed).toEqual(["old"]);
        await disposeWorkbenchItemRuntime(lease);
        expect(disposed).toEqual(["old", "new"]);
    });

    it("contains every disposal failure and rejects after attempting all resources", async () => {
        const lease = claimWorkbenchItemRuntime(createItemId("pane-failures"));
        const attempted: string[] = [];
        getOrCreateWorkbenchItemResource(lease, "core.first", "one", () => ({
            value: 1,
            dispose: () => {
                attempted.push("first");
                throw new Error("first failed");
            },
        }));
        getOrCreateWorkbenchItemResource(lease, "core.second", "two", () => ({
            value: 2,
            dispose: () => {
                attempted.push("second");
                throw new Error("second failed");
            },
        }));

        await expect(disposeWorkbenchItemRuntime(lease)).rejects.toBeInstanceOf(AggregateError);
        expect(attempted).toEqual(["second", "first"]);
        expect(workbenchItemRuntimeSnapshot()).toEqual({ items: 0, retiringItems: 0, resources: 0, pendingDisposals: 0 });
    });

    it("rejects duplicate owners, unsafe keys, invalid fingerprints, and invalid factories", () => {
        const itemId = createItemId("pane-validation");
        const lease = claimWorkbenchItemRuntime(itemId);
        expect(() => claimWorkbenchItemRuntime(itemId)).toThrow(WorkbenchItemRuntimeLeaseError);
        expect(() => getOrCreateWorkbenchItemResource(lease, "__proto__", "valid", () => ({ value: 1, dispose: () => {} }))).toThrow(TypeError);
        expect(() => getOrCreateWorkbenchItemResource(lease, "core.empty", "", () => ({ value: 1, dispose: () => {} }))).toThrow(TypeError);
        expect(() => getOrCreateWorkbenchItemResource(lease, "core.invalid", "valid", () => null as never)).toThrow(TypeError);
        expect(workbenchItemRuntimeSnapshot()).toMatchObject({ items: 1, resources: 0 });
    });
});

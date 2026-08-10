import { afterEach, describe, expect, it, vi } from "vitest";
import { createItemId } from "./registry";
import {
    disposeWorkbenchItemResources,
    getOrCreateWorkbenchItemResource,
    resetWorkbenchItemRuntimeForTests,
    workbenchItemRuntimeSnapshot,
} from "./itemRuntime";

afterEach(() => resetWorkbenchItemRuntimeForTests());

describe("workbench item runtime resources", () => {
    it("creates once across renderer acquisitions and disposes in reverse order", async () => {
        const itemId = createItemId("pane-runtime");
        const events: string[] = [];
        const first = { runtime: "pty" };
        const createFirst = vi.fn(() => ({
            value: first,
            dispose: () => {
                events.push("first");
            },
        }));

        expect(getOrCreateWorkbenchItemResource(itemId, "core.terminal", createFirst)).toBe(first);
        expect(getOrCreateWorkbenchItemResource(itemId, "core.terminal", createFirst)).toBe(first);
        getOrCreateWorkbenchItemResource(itemId, "core.tracing", () => ({
            value: { trace: true },
            dispose: async () => {
                events.push("second");
            },
        }));
        expect(createFirst).toHaveBeenCalledOnce();
        expect(workbenchItemRuntimeSnapshot()).toEqual({ items: 1, resources: 2 });

        const disposing = disposeWorkbenchItemResources(itemId);
        expect(workbenchItemRuntimeSnapshot()).toEqual({ items: 0, resources: 0 });
        await disposing;
        expect(events).toEqual(["second", "first"]);
        await disposeWorkbenchItemResources(itemId);
        expect(events).toEqual(["second", "first"]);
    });

    it("contains every disposal failure and rejects after attempting all resources", async () => {
        const itemId = createItemId("pane-failures");
        const attempted: string[] = [];
        getOrCreateWorkbenchItemResource(itemId, "core.first", () => ({
            value: 1,
            dispose: () => {
                attempted.push("first");
                throw new Error("first failed");
            },
        }));
        getOrCreateWorkbenchItemResource(itemId, "core.second", () => ({
            value: 2,
            dispose: () => {
                attempted.push("second");
                throw new Error("second failed");
            },
        }));

        await expect(disposeWorkbenchItemResources(itemId)).rejects.toBeInstanceOf(AggregateError);
        expect(attempted).toEqual(["second", "first"]);
        expect(workbenchItemRuntimeSnapshot()).toEqual({ items: 0, resources: 0 });
    });

    it("rejects unsafe keys and invalid factory results", () => {
        const itemId = createItemId("pane-validation");
        expect(() => getOrCreateWorkbenchItemResource(itemId, "__proto__", () => ({ value: 1, dispose: () => {} }))).toThrow(TypeError);
        expect(() => getOrCreateWorkbenchItemResource(itemId, "core.invalid", () => null as never)).toThrow(TypeError);
        expect(workbenchItemRuntimeSnapshot()).toEqual({ items: 0, resources: 0 });
    });
});

import { isValidWorkbenchItemId, type ItemId } from "./registry";

export interface WorkbenchItemRuntimeResource<Value> {
    readonly value: Value;
    dispose(): void | Promise<void>;
}

export interface WorkbenchItemRuntimeSnapshot {
    readonly items: number;
    readonly resources: number;
}

interface ResourceSlot {
    readonly value: unknown;
    readonly dispose: () => void | Promise<void>;
}

const MAX_RESOURCES_PER_ITEM = 32;
const RESOURCE_KEY = /^[a-z][a-z0-9._:-]{0,127}$/;
const resources = new Map<ItemId, Map<string, ResourceSlot>>();

function requireResourceKey(key: string): string {
    if (!RESOURCE_KEY.test(key) || key === "__proto__" || key === "constructor" || key === "prototype") {
        throw new TypeError(`Invalid workbench runtime resource key: ${String(key)}`);
    }
    return key;
}

/**
 * Lazily owns a runtime-only resource under a durable item ID. Renderers may
 * come and go; only item removal disposes the resource. Values are deliberately
 * absent from snapshots and cannot leak into persistence.
 */
export function getOrCreateWorkbenchItemResource<Value>(itemId: ItemId, key: string, create: () => WorkbenchItemRuntimeResource<Value>): Value {
    if (!isValidWorkbenchItemId(itemId)) throw new TypeError("Invalid workbench item ID");
    const resourceKey = requireResourceKey(key);
    let itemResources = resources.get(itemId);
    const existing = itemResources?.get(resourceKey);
    if (existing) return existing.value as Value;
    if (itemResources && itemResources.size >= MAX_RESOURCES_PER_ITEM) {
        throw new RangeError(`Workbench item ${itemId} reached its runtime resource limit`);
    }

    const created = create();
    if (!created || typeof created !== "object" || typeof created.dispose !== "function") {
        throw new TypeError("Workbench runtime resource factories must return a value and disposer");
    }
    itemResources ??= new Map();
    itemResources.set(resourceKey, { value: created.value, dispose: created.dispose });
    resources.set(itemId, itemResources);
    return created.value;
}

/** Delete ownership synchronously, then dispose every resource in reverse registration order. */
export async function disposeWorkbenchItemResources(itemId: ItemId): Promise<void> {
    const itemResources = resources.get(itemId);
    if (!itemResources) return;
    resources.delete(itemId);
    const failures: unknown[] = [];
    for (const resource of Array.from(itemResources.values()).reverse()) {
        try {
            await resource.dispose();
        } catch (error) {
            failures.push(error);
        }
    }
    if (failures.length > 0) throw new AggregateError(failures, `Failed to dispose runtime resources for ${itemId}`);
}

export function workbenchItemRuntimeSnapshot(): WorkbenchItemRuntimeSnapshot {
    let count = 0;
    for (const itemResources of resources.values()) count += itemResources.size;
    return { items: resources.size, resources: count };
}

export async function resetWorkbenchItemRuntimeForTests(): Promise<void> {
    const itemIds = Array.from(resources.keys());
    const results = await Promise.allSettled(itemIds.map(disposeWorkbenchItemResources));
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected").map((result) => result.reason);
    if (failures.length > 0) throw new AggregateError(failures, "Failed to reset workbench runtime resources");
}

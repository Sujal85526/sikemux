import { isValidWorkbenchItemId, type ItemId } from "./registry";

declare const RUNTIME_LEASE_BRAND: unique symbol;

export interface WorkbenchItemRuntimeLease {
    readonly itemId: ItemId;
    readonly generation: number;
    readonly [RUNTIME_LEASE_BRAND]: "WorkbenchItemRuntimeLease";
}

export interface WorkbenchItemRuntimeResource<Value> {
    readonly value: Value;
    dispose(): void | Promise<void>;
}

export interface WorkbenchItemRuntimeSnapshot {
    readonly items: number;
    readonly retiringItems: number;
    readonly resources: number;
    readonly pendingDisposals: number;
}

interface ResourceSlot {
    readonly fingerprint: string;
    readonly value: unknown;
    readonly dispose: () => void | Promise<void>;
}

interface RuntimeOwner {
    readonly lease: WorkbenchItemRuntimeLease;
    readonly resources: Map<string, ResourceSlot>;
    readonly pendingDisposals: Set<Promise<void>>;
    readonly disposalFailures: unknown[];
    active: boolean;
    disposePromise: Promise<void> | null;
}

export class WorkbenchItemRuntimeLeaseError extends Error {
    constructor(message = "Workbench item runtime ownership is no longer active") {
        super(message);
        this.name = "WorkbenchItemRuntimeLeaseError";
    }
}

const MAX_RESOURCES_PER_ITEM = 32;
const MAX_FINGERPRINT_LENGTH = 16_384;
const MAX_DISPOSAL_FAILURES = 32;
const RESOURCE_KEY = /^[a-z][a-z0-9._:-]{0,127}$/;
const activeOwners = new Map<ItemId, RuntimeOwner>();
const owners = new Set<RuntimeOwner>();
const ownersByLease = new WeakMap<WorkbenchItemRuntimeLease, RuntimeOwner>();
let nextGeneration = 1;

function requireItemId(itemId: ItemId): ItemId {
    if (!isValidWorkbenchItemId(itemId)) throw new TypeError("Invalid workbench item ID");
    return itemId;
}

function requireResourceKey(key: string): string {
    if (!RESOURCE_KEY.test(key) || key === "__proto__" || key === "constructor" || key === "prototype") {
        throw new TypeError(`Invalid workbench runtime resource key: ${String(key)}`);
    }
    return key;
}

function requireFingerprint(fingerprint: string): string {
    if (typeof fingerprint !== "string" || fingerprint.length === 0 || fingerprint.length > MAX_FINGERPRINT_LENGTH) {
        throw new TypeError("Workbench runtime resource fingerprints must be non-empty and bounded");
    }
    return fingerprint;
}

function ownerForActiveLease(lease: WorkbenchItemRuntimeLease): RuntimeOwner {
    const owner = ownersByLease.get(lease);
    if (!owner || !owner.active || activeOwners.get(lease.itemId) !== owner) throw new WorkbenchItemRuntimeLeaseError();
    return owner;
}

function queueResourceDisposal(owner: RuntimeOwner, resource: ResourceSlot): void {
    const pending = Promise.resolve().then(() => resource.dispose());
    owner.pendingDisposals.add(pending);
    void pending.then(
        () => owner.pendingDisposals.delete(pending),
        (error: unknown) => {
            owner.pendingDisposals.delete(pending);
            if (owner.disposalFailures.length < MAX_DISPOSAL_FAILURES) owner.disposalFailures.push(error);
        },
    );
}

/** Establishes one synchronous ownership generation before any renderer mounts. */
export function claimWorkbenchItemRuntime(itemId: ItemId): WorkbenchItemRuntimeLease {
    const id = requireItemId(itemId);
    if (activeOwners.has(id)) throw new WorkbenchItemRuntimeLeaseError(`Workbench item runtime is already owned: ${id}`);
    if (!Number.isSafeInteger(nextGeneration)) throw new RangeError("Workbench item runtime generation space exhausted");
    const lease = Object.freeze({ itemId: id, generation: nextGeneration }) as WorkbenchItemRuntimeLease;
    nextGeneration += 1;
    const owner: RuntimeOwner = {
        lease,
        resources: new Map(),
        pendingDisposals: new Set(),
        disposalFailures: [],
        active: true,
        disposePromise: null,
    };
    activeOwners.set(id, owner);
    owners.add(owner);
    ownersByLease.set(lease, owner);
    return lease;
}

/** Captures the current generation during render; stale captures cannot mutate a replacement owner. */
export function captureWorkbenchItemRuntimeLease(itemId: ItemId): WorkbenchItemRuntimeLease | null {
    return activeOwners.get(requireItemId(itemId))?.lease ?? null;
}

/**
 * Closes acquisition synchronously while leaving already-borrowed values alive
 * for controller deactivation. A replacement item may immediately claim the ID.
 */
export function closeWorkbenchItemRuntime(lease: WorkbenchItemRuntimeLease): boolean {
    const owner = ownersByLease.get(lease);
    if (!owner || !owner.active || activeOwners.get(lease.itemId) !== owner) return false;
    owner.active = false;
    activeOwners.delete(lease.itemId);
    return true;
}

/**
 * Borrows a generation-scoped resource. A configuration change replaces the
 * old resource instead of silently reusing a PTY launched with stale options.
 */
export function getOrCreateWorkbenchItemResource<Value>(
    lease: WorkbenchItemRuntimeLease,
    key: string,
    fingerprint: string,
    create: () => WorkbenchItemRuntimeResource<Value>,
): Value {
    const owner = ownerForActiveLease(lease);
    const resourceKey = requireResourceKey(key);
    const resourceFingerprint = requireFingerprint(fingerprint);
    const existing = owner.resources.get(resourceKey);
    if (existing?.fingerprint === resourceFingerprint) return existing.value as Value;
    if (existing) {
        owner.resources.delete(resourceKey);
        queueResourceDisposal(owner, existing);
    } else if (owner.resources.size >= MAX_RESOURCES_PER_ITEM) {
        throw new RangeError(`Workbench item ${lease.itemId} reached its runtime resource limit`);
    }

    const created = create();
    if (!created || typeof created !== "object" || typeof created.dispose !== "function") {
        throw new TypeError("Workbench runtime resource factories must return a value and disposer");
    }
    owner.resources.set(resourceKey, {
        fingerprint: resourceFingerprint,
        value: created.value,
        dispose: created.dispose,
    });
    return created.value;
}

/** Close ownership now, then dispose resources in reverse registration order exactly once. */
export function disposeWorkbenchItemRuntime(lease: WorkbenchItemRuntimeLease): Promise<void> {
    const owner = ownersByLease.get(lease);
    if (!owner) return Promise.resolve();
    closeWorkbenchItemRuntime(lease);
    if (owner.disposePromise) return owner.disposePromise;

    const currentResources = Array.from(owner.resources.values()).reverse();
    owner.resources.clear();
    for (const resource of currentResources) queueResourceDisposal(owner, resource);
    const pending = Array.from(owner.pendingDisposals);
    owner.disposePromise = Promise.allSettled(pending).then(() => {
        owners.delete(owner);
        if (owner.disposalFailures.length > 0) {
            const failures = owner.disposalFailures.splice(0);
            throw new AggregateError(failures, `Failed to dispose runtime resources for ${lease.itemId}`);
        }
    });
    // Preserve rejection for lifecycle observers while preventing an unhandled
    // rejection when teardown itself is fire-and-forget.
    void owner.disposePromise.catch(() => {});
    return owner.disposePromise;
}

export function workbenchItemRuntimeSnapshot(): WorkbenchItemRuntimeSnapshot {
    let resourceCount = 0;
    let pendingDisposals = 0;
    let retiringItems = 0;
    for (const owner of owners) {
        resourceCount += owner.resources.size;
        pendingDisposals += owner.pendingDisposals.size;
        if (!owner.active) retiringItems += 1;
    }
    return {
        items: activeOwners.size,
        retiringItems,
        resources: resourceCount,
        pendingDisposals,
    };
}

export async function resetWorkbenchItemRuntimeForTests(): Promise<void> {
    const results = await Promise.allSettled(Array.from(owners, (owner) => disposeWorkbenchItemRuntime(owner.lease)));
    activeOwners.clear();
    owners.clear();
    nextGeneration = 1;
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected").map((result) => result.reason);
    if (failures.length > 0) throw new AggregateError(failures, "Failed to reset workbench runtime resources");
}

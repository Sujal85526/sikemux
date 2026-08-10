declare const INTERNAL_EXTENSION_ID_BRAND: unique symbol;
declare const EXTENSION_CONTRIBUTION_ID_BRAND: unique symbol;

export type InternalExtensionId = string & { readonly [INTERNAL_EXTENSION_ID_BRAND]: "InternalExtensionId" };
export type ExtensionContributionId = string & { readonly [EXTENSION_CONTRIBUTION_ID_BRAND]: "ExtensionContributionId" };

export type ExtensionContributionKind = "action" | "workbench-item" | "task-provider";
export type ExtensionFailureStage = "predicate" | "factory" | "register" | "dispose";

export interface ExtensionContributionContext {
    readonly extensionId: InternalExtensionId;
    readonly contributionId: ExtensionContributionId;
    readonly kind: ExtensionContributionKind;
    readonly localId: string;
}

export interface InternalExtensionContribution<Value> {
    readonly id: string;
    /** Synchronous availability predicate over bounded scalar identity only. */
    readonly when?: (context: ExtensionContributionContext) => boolean;
    /** Synchronous trusted contribution factory. */
    readonly create: (context: ExtensionContributionContext) => Value;
}

export interface InternalExtensionManifest<Action, WorkbenchItem, TaskProvider> {
    readonly id: string;
    readonly actions?: readonly InternalExtensionContribution<Action>[];
    readonly workbenchItems?: readonly InternalExtensionContribution<WorkbenchItem>[];
    readonly taskProviders?: readonly InternalExtensionContribution<TaskProvider>[];
}

export interface ExtensionContributionRegistration {
    dispose(): void;
}

/** Adapts a framework-specific registry without coupling the host to it. */
export interface ExtensionContributionAdapter<Value> {
    register(value: Value, context: ExtensionContributionContext): ExtensionContributionRegistration;
}

export interface InternalExtensionHostAdapters<Action, WorkbenchItem, TaskProvider> {
    readonly actions: ExtensionContributionAdapter<Action>;
    readonly workbenchItems: ExtensionContributionAdapter<WorkbenchItem>;
    readonly taskProviders: ExtensionContributionAdapter<TaskProvider>;
}

export interface InternalExtensionHostOptions {
    readonly maxExtensions?: number;
    readonly maxContributionsPerExtension?: number;
    readonly maxTotalContributions?: number;
    readonly maxFailureHistory?: number;
}

export interface ExtensionContributionCounts {
    readonly actions: number;
    readonly workbenchItems: number;
    readonly taskProviders: number;
}

export interface InternalExtensionSnapshot {
    readonly id: InternalExtensionId;
    readonly registrationOrder: number;
    readonly declaredContributions: number;
    readonly activeContributions: number;
    readonly contributionCounts: ExtensionContributionCounts;
}

export interface ExtensionHostFailure {
    readonly sequence: number;
    readonly extensionId: InternalExtensionId;
    readonly contributionId: ExtensionContributionId;
    readonly kind: ExtensionContributionKind;
    readonly stage: ExtensionFailureStage;
    readonly message: string;
}

export interface InternalExtensionHostSnapshot {
    readonly disposed: boolean;
    readonly extensionCount: number;
    readonly declaredContributions: number;
    readonly activeContributions: number;
    readonly contributionCounts: ExtensionContributionCounts;
    readonly failureCount: number;
    readonly extensions: readonly InternalExtensionSnapshot[];
    readonly failures: readonly ExtensionHostFailure[];
}

export interface InternalExtensionRegistration {
    readonly id: InternalExtensionId;
    readonly disposed: boolean;
    readonly activeContributions: number;
    dispose(): void;
}

export const INTERNAL_EXTENSION_HOST_LIMITS = Object.freeze({
    maxExtensions: 128,
    maxContributionsPerExtension: 256,
    maxTotalContributions: 4_096,
    maxExtensionIdLength: 128,
    maxContributionIdLength: 128,
    maxFailureHistory: 64,
    maxFailureMessageLength: 512,
});

export class DuplicateInternalExtensionError extends Error {
    constructor(readonly extensionId: InternalExtensionId) {
        super(`Internal extension is already registered: ${extensionId}`);
        this.name = "DuplicateInternalExtensionError";
    }
}

export class DuplicateExtensionContributionError extends Error {
    constructor(
        readonly extensionId: InternalExtensionId,
        readonly kind: ExtensionContributionKind,
        readonly localId: string,
    ) {
        super(`Duplicate ${kind} contribution in ${extensionId}: ${localId}`);
        this.name = "DuplicateExtensionContributionError";
    }
}

export class InternalExtensionHostDisposedError extends Error {
    constructor() {
        super("Internal extension host has been disposed");
        this.name = "InternalExtensionHostDisposedError";
    }
}

type NormalizedContribution<Value> = {
    readonly id: string;
    readonly when: ((context: ExtensionContributionContext) => boolean) | undefined;
    readonly create: (context: ExtensionContributionContext) => Value;
};

type NormalizedManifest<Action, WorkbenchItem, TaskProvider> = {
    readonly id: InternalExtensionId;
    readonly actions: readonly NormalizedContribution<Action>[];
    readonly workbenchItems: readonly NormalizedContribution<WorkbenchItem>[];
    readonly taskProviders: readonly NormalizedContribution<TaskProvider>[];
    readonly declaredContributions: number;
};

type ActiveContribution = {
    readonly context: ExtensionContributionContext;
    readonly registrationOrder: number;
    readonly dispose: () => unknown;
    active: boolean;
};

type ExtensionRecord = {
    readonly id: InternalExtensionId;
    readonly registrationOrder: number;
    readonly declaredContributions: number;
    readonly contributions: ActiveContribution[];
    active: boolean;
};

type ResolvedLimits = {
    readonly maxExtensions: number;
    readonly maxContributionsPerExtension: number;
    readonly maxTotalContributions: number;
    readonly maxFailureHistory: number;
};

const EXTENSION_ID_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/u;
const CONTRIBUTION_ID_PATTERN = /^[a-z][a-z0-9-]*(?:[._:-][a-z0-9-]+)*$/u;
const UNSAFE_ID_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);
const DEFAULT_FAILURE_MESSAGE = "Internal extension contribution failed";

function containsControlCharacter(value: string): boolean {
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code <= 31 || (code >= 127 && code <= 159)) return true;
    }
    return false;
}

function containsUnsafeSegment(value: string): boolean {
    return value.split(/[._:-]/u).some((segment) => UNSAFE_ID_SEGMENTS.has(segment));
}

export function createInternalExtensionId(value: string): InternalExtensionId {
    if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > INTERNAL_EXTENSION_HOST_LIMITS.maxExtensionIdLength ||
        value !== value.trim() ||
        containsControlCharacter(value) ||
        containsUnsafeSegment(value) ||
        !EXTENSION_ID_PATTERN.test(value)
    ) {
        throw new TypeError("internal extension IDs must be bounded lowercase namespaces with at least two safe segments");
    }
    return value as InternalExtensionId;
}

function requireContributionId(value: unknown): string {
    if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > INTERNAL_EXTENSION_HOST_LIMITS.maxContributionIdLength ||
        value !== value.trim() ||
        containsControlCharacter(value) ||
        containsUnsafeSegment(value) ||
        !CONTRIBUTION_ID_PATTERN.test(value)
    ) {
        throw new TypeError("extension contribution IDs must be bounded lowercase record-safe identifiers");
    }
    return value;
}

function contributionId(extensionId: InternalExtensionId, kind: ExtensionContributionKind, localId: string): ExtensionContributionId {
    return `internal:${extensionId}/${kind}/${localId}` as ExtensionContributionId;
}

function requireLimit(name: string, value: number | undefined, fallback: number, hardLimit: number): number {
    const resolved = value ?? fallback;
    if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > hardLimit) {
        throw new RangeError(`${name} must be a positive integer no greater than ${hardLimit}`);
    }
    return resolved;
}

function resolveLimits(options: InternalExtensionHostOptions): ResolvedLimits {
    return Object.freeze({
        maxExtensions: requireLimit(
            "maxExtensions",
            options.maxExtensions,
            INTERNAL_EXTENSION_HOST_LIMITS.maxExtensions,
            INTERNAL_EXTENSION_HOST_LIMITS.maxExtensions,
        ),
        maxContributionsPerExtension: requireLimit(
            "maxContributionsPerExtension",
            options.maxContributionsPerExtension,
            INTERNAL_EXTENSION_HOST_LIMITS.maxContributionsPerExtension,
            INTERNAL_EXTENSION_HOST_LIMITS.maxContributionsPerExtension,
        ),
        maxTotalContributions: requireLimit(
            "maxTotalContributions",
            options.maxTotalContributions,
            INTERNAL_EXTENSION_HOST_LIMITS.maxTotalContributions,
            INTERNAL_EXTENSION_HOST_LIMITS.maxTotalContributions,
        ),
        maxFailureHistory: requireLimit(
            "maxFailureHistory",
            options.maxFailureHistory,
            INTERNAL_EXTENSION_HOST_LIMITS.maxFailureHistory,
            INTERNAL_EXTENSION_HOST_LIMITS.maxFailureHistory,
        ),
    });
}

function validateAdapter(name: string, value: unknown): void {
    if (typeof value !== "object" || value === null || typeof (value as Partial<ExtensionContributionAdapter<unknown>>).register !== "function") {
        throw new TypeError(`${name} extension adapter must provide register`);
    }
}

function normalizeContributions<Value>(
    extensionId: InternalExtensionId,
    kind: ExtensionContributionKind,
    values: readonly InternalExtensionContribution<Value>[] | undefined,
): readonly NormalizedContribution<Value>[] {
    if (values === undefined) return Object.freeze([]);
    if (!Array.isArray(values)) throw new TypeError(`${kind} contributions must be an array`);
    const ids = new Set<string>();
    return Object.freeze(
        Array.from(values, (value) => {
            if (typeof value !== "object" || value === null) throw new TypeError(`${kind} contributions must be objects`);
            const id = requireContributionId(value.id);
            const when = value.when;
            const create = value.create;
            if (ids.has(id)) throw new DuplicateExtensionContributionError(extensionId, kind, id);
            ids.add(id);
            if (when !== undefined && typeof when !== "function") {
                throw new TypeError(`${kind} contribution predicates must be functions`);
            }
            if (typeof create !== "function") throw new TypeError(`${kind} contributions must provide a factory`);
            return Object.freeze({ id, when, create });
        }),
    );
}

function normalizeManifest<Action, WorkbenchItem, TaskProvider>(
    manifest: InternalExtensionManifest<Action, WorkbenchItem, TaskProvider>,
    maxContributions: number,
): NormalizedManifest<Action, WorkbenchItem, TaskProvider> {
    if (typeof manifest !== "object" || manifest === null) throw new TypeError("internal extension manifests must be objects");
    const id = createInternalExtensionId(manifest.id);
    const actionsInput = manifest.actions;
    const workbenchItemsInput = manifest.workbenchItems;
    const taskProvidersInput = manifest.taskProviders;
    const groups = [actionsInput, workbenchItemsInput, taskProvidersInput];
    for (const group of groups) {
        if (group !== undefined && !Array.isArray(group)) throw new TypeError("internal extension contribution groups must be arrays");
    }
    const declaredContributions = groups.reduce((count, group) => count + (group?.length ?? 0), 0);
    if (declaredContributions > maxContributions) {
        throw new RangeError(`internal extensions cannot declare more than ${maxContributions} contributions`);
    }
    const actions = normalizeContributions(id, "action", actionsInput);
    const workbenchItems = normalizeContributions(id, "workbench-item", workbenchItemsInput);
    const taskProviders = normalizeContributions(id, "task-provider", taskProvidersInput);
    return Object.freeze({
        id,
        actions,
        workbenchItems,
        taskProviders,
        declaredContributions,
    });
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
    if ((typeof value !== "object" && typeof value !== "function") || value === null) return false;
    return typeof (value as Partial<PromiseLike<unknown>>).then === "function";
}

function containPromise(value: unknown): void {
    try {
        if (isPromiseLike(value)) void Promise.resolve(value).catch(() => {});
    } catch {
        // Hostile then access never escapes containment.
    }
}

function normalizeRegistration(value: unknown): () => unknown {
    if ((typeof value !== "object" && typeof value !== "function") || value === null) {
        containPromise(value);
        throw new TypeError("extension adapters must return a disposable registration");
    }
    const dispose = (value as Partial<ExtensionContributionRegistration>).dispose;
    if (typeof dispose !== "function") {
        containPromise(value);
        throw new TypeError("extension adapters must return a disposable registration");
    }
    return () => Reflect.apply(dispose, value, []);
}

function sanitizeFailureMessage(error: unknown): string {
    let raw = DEFAULT_FAILURE_MESSAGE;
    if (typeof error === "string") raw = error;
    else if ((typeof error === "object" || typeof error === "function") && error !== null) {
        try {
            const descriptor = Object.getOwnPropertyDescriptor(error, "message");
            if (descriptor && "value" in descriptor && typeof descriptor.value === "string") raw = descriptor.value;
        } catch {
            // Never enumerate or stringify contributor errors.
        }
    }

    let sanitized = "";
    for (const character of raw.slice(0, INTERNAL_EXTENSION_HOST_LIMITS.maxFailureMessageLength)) {
        const code = character.charCodeAt(0);
        sanitized += code <= 31 || (code >= 127 && code <= 159) ? " " : character;
    }
    sanitized = sanitized.trim();
    return sanitized || DEFAULT_FAILURE_MESSAGE;
}

function emptyCounts(): ExtensionContributionCounts {
    return { actions: 0, workbenchItems: 0, taskProviders: 0 };
}

function incrementKind(counts: ExtensionContributionCounts, kind: ExtensionContributionKind): void {
    const mutable = counts as { actions: number; workbenchItems: number; taskProviders: number };
    if (kind === "action") mutable.actions += 1;
    else if (kind === "workbench-item") mutable.workbenchItems += 1;
    else mutable.taskProviders += 1;
}

/**
 * Owns static, trusted in-process contributions. It deliberately provides no
 * module loading, evaluation, filesystem, network, or third-party runtime API.
 */
export class InternalExtensionHost<Action = unknown, WorkbenchItem = unknown, TaskProvider = unknown> {
    private readonly adapters: InternalExtensionHostAdapters<Action, WorkbenchItem, TaskProvider>;
    private readonly limits: ResolvedLimits;
    private readonly extensions = new Map<InternalExtensionId, ExtensionRecord>();
    private readonly failures: ExtensionHostFailure[] = [];
    private nextExtensionOrder = 1;
    private nextContributionOrder = 1;
    private failureSequence = 0;
    private disposed = false;

    constructor(adapters: InternalExtensionHostAdapters<Action, WorkbenchItem, TaskProvider>, options: InternalExtensionHostOptions = {}) {
        if (typeof adapters !== "object" || adapters === null) throw new TypeError("internal extension host adapters are required");
        validateAdapter("action", adapters.actions);
        validateAdapter("workbench item", adapters.workbenchItems);
        validateAdapter("task provider", adapters.taskProviders);
        this.adapters = adapters;
        this.limits = resolveLimits(options);
    }

    register(manifestInput: InternalExtensionManifest<Action, WorkbenchItem, TaskProvider>): InternalExtensionRegistration {
        if (this.disposed) throw new InternalExtensionHostDisposedError();
        const manifest = normalizeManifest(manifestInput, this.limits.maxContributionsPerExtension);
        if (this.extensions.has(manifest.id)) throw new DuplicateInternalExtensionError(manifest.id);
        if (this.extensions.size >= this.limits.maxExtensions) {
            throw new RangeError(`internal extension host cannot exceed ${this.limits.maxExtensions} extensions`);
        }
        if (this.declaredContributionCount + manifest.declaredContributions > this.limits.maxTotalContributions) {
            throw new RangeError(`internal extension host cannot exceed ${this.limits.maxTotalContributions} declared contributions`);
        }

        const record: ExtensionRecord = {
            id: manifest.id,
            registrationOrder: this.nextExtensionOrder,
            declaredContributions: manifest.declaredContributions,
            contributions: [],
            active: true,
        };
        this.nextExtensionOrder += 1;
        this.extensions.set(record.id, record);

        this.activate(record, "action", manifest.actions, this.adapters.actions);
        this.activate(record, "workbench-item", manifest.workbenchItems, this.adapters.workbenchItems);
        this.activate(record, "task-provider", manifest.taskProviders, this.adapters.taskProviders);

        return Object.freeze({
            id: record.id,
            get disposed() {
                return !record.active;
            },
            get activeContributions() {
                return record.contributions.filter(({ active }) => active).length;
            },
            dispose: () => this.revoke(record),
        });
    }

    getSnapshot(): InternalExtensionHostSnapshot {
        const totalCounts = emptyCounts();
        let activeContributions = 0;
        const extensions = Array.from(this.extensions.values())
            .sort((left, right) => left.registrationOrder - right.registrationOrder)
            .map((record): InternalExtensionSnapshot => {
                const counts = emptyCounts();
                for (const contribution of record.contributions) {
                    if (!contribution.active) continue;
                    activeContributions += 1;
                    incrementKind(counts, contribution.context.kind);
                    incrementKind(totalCounts, contribution.context.kind);
                }
                return Object.freeze({
                    id: record.id,
                    registrationOrder: record.registrationOrder,
                    declaredContributions: record.declaredContributions,
                    activeContributions: counts.actions + counts.workbenchItems + counts.taskProviders,
                    contributionCounts: Object.freeze(counts),
                });
            });
        return Object.freeze({
            disposed: this.disposed,
            extensionCount: this.extensions.size,
            declaredContributions: this.declaredContributionCount,
            activeContributions,
            contributionCounts: Object.freeze(totalCounts),
            failureCount: this.failureSequence,
            extensions: Object.freeze(extensions),
            failures: Object.freeze(this.failures.slice()),
        });
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        const records = Array.from(this.extensions.values()).sort((left, right) => right.registrationOrder - left.registrationOrder);
        for (const record of records) this.revoke(record);
    }

    private get declaredContributionCount(): number {
        let count = 0;
        for (const extension of this.extensions.values()) count += extension.declaredContributions;
        return count;
    }

    private activate<Value>(
        record: ExtensionRecord,
        kind: ExtensionContributionKind,
        contributions: readonly NormalizedContribution<Value>[],
        adapter: ExtensionContributionAdapter<Value>,
    ): void {
        for (const contribution of contributions) {
            if (!record.active || this.disposed) break;
            const context = Object.freeze({
                extensionId: record.id,
                contributionId: contributionId(record.id, kind, contribution.id),
                kind,
                localId: contribution.id,
            });
            if (contribution.when) {
                try {
                    const included = contribution.when(context);
                    if (typeof included !== "boolean") {
                        containPromise(included);
                        throw new TypeError("extension contribution predicates must return boolean");
                    }
                    if (!included) continue;
                } catch (error) {
                    this.recordFailure(context, "predicate", error);
                    continue;
                }
            }
            if (!record.active || this.disposed) break;

            let value: Value;
            try {
                value = contribution.create(context);
                if (isPromiseLike(value)) {
                    containPromise(value);
                    throw new TypeError("extension contribution factories must be synchronous");
                }
            } catch (error) {
                this.recordFailure(context, "factory", error);
                continue;
            }
            if (!record.active || this.disposed) break;

            try {
                const dispose = normalizeRegistration(adapter.register(value, context));
                if (!record.active || this.disposed) {
                    this.disposeContribution(context, dispose);
                    break;
                }
                record.contributions.push({
                    context,
                    registrationOrder: this.nextContributionOrder,
                    dispose,
                    active: true,
                });
                this.nextContributionOrder += 1;
            } catch (error) {
                this.recordFailure(context, "register", error);
            }
        }
    }

    private revoke(record: ExtensionRecord): void {
        if (!record.active) return;
        record.active = false;
        const contributions = record.contributions.slice().sort((left, right) => right.registrationOrder - left.registrationOrder);
        for (const contribution of contributions) {
            if (!contribution.active) continue;
            contribution.active = false;
            this.disposeContribution(contribution.context, contribution.dispose);
        }
        record.contributions.length = 0;
        this.extensions.delete(record.id);
    }

    private disposeContribution(context: ExtensionContributionContext, dispose: () => unknown): void {
        try {
            const result = dispose();
            if (isPromiseLike(result)) {
                void Promise.resolve(result).catch((error: unknown) => this.recordFailure(context, "dispose", error));
            }
        } catch (error) {
            this.recordFailure(context, "dispose", error);
        }
    }

    private recordFailure(context: ExtensionContributionContext, stage: ExtensionFailureStage, error: unknown): void {
        this.failureSequence += 1;
        const failure = Object.freeze({
            sequence: this.failureSequence,
            extensionId: context.extensionId,
            contributionId: context.contributionId,
            kind: context.kind,
            stage,
            message: sanitizeFailureMessage(error),
        });
        if (this.failures.length >= this.limits.maxFailureHistory) this.failures.shift();
        this.failures.push(failure);
    }
}

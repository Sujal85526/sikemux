import { LSP_PAYLOAD_LIMITS, lsp, type LspDiagnosticsListener, type LspDiagnosticsPayload } from "../api/lsp";
import { DiagnosticsController, type DiagnosticsControllerSnapshot, type DiagnosticsServerGeneration } from "./diagnosticsController";

export type ProjectDiagnosticsSourceSubscribe = (listener: LspDiagnosticsListener) => (() => void) | PromiseLike<() => void>;

export interface ProjectDiagnosticsRuntimeOptions {
    readonly maxProjects?: number;
    readonly maxReferencesPerProject?: number;
    readonly maxSubscribersPerProject?: number;
}

export interface ProjectDiagnosticsLease {
    readonly project: string;
    readonly controller: DiagnosticsController;
    /** Settles when the shared native diagnostics listener is established. */
    readonly ready: Promise<void>;
    readonly released: boolean;
    /** Referentially stable between controller mutations for useSyncExternalStore. */
    readonly getSnapshot: () => DiagnosticsControllerSnapshot;
    readonly subscribe: (listener: () => void) => () => void;
    release(): void;
}

export const PROJECT_DIAGNOSTICS_RUNTIME_LIMITS = Object.freeze({
    maxProjects: 64,
    maxReferencesPerProject: 1_024,
    maxSubscribersPerProject: 128,
});

export class ProjectDiagnosticsRuntimeDisposedError extends Error {
    constructor() {
        super("Project diagnostics runtime has been disposed");
        this.name = "ProjectDiagnosticsRuntimeDisposedError";
    }
}

type ProjectRecord = {
    readonly project: string;
    readonly controller: DiagnosticsController;
    readonly servers: Map<string, DiagnosticsServerGeneration>;
    readonly listeners: Set<() => void>;
    controllerUnsubscribe: () => void;
    snapshot: DiagnosticsControllerSnapshot;
    references: number;
    active: boolean;
};

type ResolvedLimits = {
    readonly maxProjects: number;
    readonly maxReferencesPerProject: number;
    readonly maxSubscribersPerProject: number;
};

const UTF8_ENCODER = new TextEncoder();
const RESOLVED_VOID = Promise.resolve();

function containsControlCharacter(value: string): boolean {
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code <= 31 || (code >= 127 && code <= 159)) return true;
    }
    return false;
}

function boundedUtf8(value: string, maxBytes: number): boolean {
    return value.length <= maxBytes && UTF8_ENCODER.encode(value).byteLength <= maxBytes;
}

function requireProject(value: unknown): string {
    if (
        typeof value !== "string" ||
        value.trim().length === 0 ||
        !boundedUtf8(value, LSP_PAYLOAD_LIMITS.maxPathBytes) ||
        containsControlCharacter(value)
    ) {
        throw new TypeError("diagnostics project must be a bounded non-blank path without control characters");
    }
    return value;
}

function requireLanguage(value: unknown): string {
    if (
        typeof value !== "string" ||
        value.length === 0 ||
        value !== value.trim() ||
        !boundedUtf8(value, LSP_PAYLOAD_LIMITS.maxLanguageBytes) ||
        containsControlCharacter(value)
    ) {
        throw new TypeError("diagnostics language must be bounded, trimmed text without control characters");
    }
    return value;
}

function requireLimit(name: string, value: number | undefined, fallback: number, hardLimit: number): number {
    const resolved = value ?? fallback;
    if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > hardLimit) {
        throw new RangeError(`${name} must be a positive integer no greater than ${hardLimit}`);
    }
    return resolved;
}

function resolveLimits(options: ProjectDiagnosticsRuntimeOptions): ResolvedLimits {
    return Object.freeze({
        maxProjects: requireLimit(
            "maxProjects",
            options.maxProjects,
            PROJECT_DIAGNOSTICS_RUNTIME_LIMITS.maxProjects,
            PROJECT_DIAGNOSTICS_RUNTIME_LIMITS.maxProjects,
        ),
        maxReferencesPerProject: requireLimit(
            "maxReferencesPerProject",
            options.maxReferencesPerProject,
            PROJECT_DIAGNOSTICS_RUNTIME_LIMITS.maxReferencesPerProject,
            PROJECT_DIAGNOSTICS_RUNTIME_LIMITS.maxReferencesPerProject,
        ),
        maxSubscribersPerProject: requireLimit(
            "maxSubscribersPerProject",
            options.maxSubscribersPerProject,
            PROJECT_DIAGNOSTICS_RUNTIME_LIMITS.maxSubscribersPerProject,
            PROJECT_DIAGNOSTICS_RUNTIME_LIMITS.maxSubscribersPerProject,
        ),
    });
}

function once(callback: () => void): () => void {
    let called = false;
    return () => {
        if (called) return;
        called = true;
        callback();
    };
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
    if ((typeof value !== "object" && typeof value !== "function") || value === null) return false;
    return typeof (value as Partial<PromiseLike<unknown>>).then === "function";
}

function safeUnsubscribe(unsubscribe: (() => void) | null): void {
    if (!unsubscribe) return;
    try {
        const result: unknown = unsubscribe();
        if (isPromiseLike(result)) void Promise.resolve(result).catch(() => {});
    } catch {
        // Native teardown cannot prevent project cleanup.
    }
}

function containedRejected(error: unknown): Promise<void> {
    const rejected = Promise.reject(error);
    void rejected.catch(() => {});
    return rejected;
}

/**
 * Ref-counted project diagnostics with one global native event subscription.
 * The event stream is routed only to an acquired matching project and its
 * currently active language generation.
 */
export class ProjectDiagnosticsRuntime {
    private readonly sourceSubscribe: ProjectDiagnosticsSourceSubscribe;
    private readonly limits: ResolvedLimits;
    private readonly projects = new Map<string, ProjectRecord>();
    private unsubscribeSource: (() => void) | null = null;
    private sourcePromise: Promise<void> | null = null;
    private sourceGeneration = 0;
    private nextServerGeneration = 1;
    private disposed = false;

    constructor(
        sourceSubscribe: ProjectDiagnosticsSourceSubscribe = (listener) => lsp.subscribeDiagnostics(listener),
        options: ProjectDiagnosticsRuntimeOptions = {},
    ) {
        if (typeof sourceSubscribe !== "function") throw new TypeError("project diagnostics source must be a function");
        this.sourceSubscribe = sourceSubscribe;
        this.limits = resolveLimits(options);
    }

    acquire(projectInput: string): ProjectDiagnosticsLease {
        if (this.disposed) throw new ProjectDiagnosticsRuntimeDisposedError();
        const project = requireProject(projectInput);
        let record = this.projects.get(project);
        if (!record) {
            if (this.projects.size >= this.limits.maxProjects) {
                throw new RangeError(`project diagnostics runtime cannot exceed ${this.limits.maxProjects} active projects`);
            }
            record = this.createRecord(project);
            this.projects.set(project, record);
        }
        if (record.references >= this.limits.maxReferencesPerProject) {
            throw new RangeError(`project diagnostics references cannot exceed ${this.limits.maxReferencesPerProject} per project`);
        }
        record.references += 1;
        return this.createLease(record, this.ensureSource());
    }

    /** Mark one successful inactive-to-active LSP server transition. */
    noteServerStarted(projectInput: string, languageInput: string): DiagnosticsServerGeneration | null {
        if (this.disposed) return null;
        const project = requireProject(projectInput);
        const language = requireLanguage(languageInput);
        const record = this.projects.get(project);
        if (!record?.active) return null;
        const current = record.servers.get(language);
        if (current !== undefined) return current;
        const generation = this.issueServerGeneration();
        record.servers.set(language, generation);
        try {
            record.controller.activateServer(language, generation);
        } catch (error) {
            record.servers.delete(language);
            throw error;
        }
        return generation;
    }

    noteServerStopped(projectInput: string, languageInput: string): boolean {
        if (this.disposed) return false;
        const project = requireProject(projectInput);
        const language = requireLanguage(languageInput);
        const record = this.projects.get(project);
        const generation = record?.servers.get(language);
        if (!record?.active || generation === undefined) return false;
        const stopped = record.controller.shutdownServer(language, generation);
        if (stopped) record.servers.delete(language);
        return stopped;
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.stopSource();
        const records = Array.from(this.projects.values());
        this.projects.clear();
        for (const record of records) this.disposeRecord(record);
    }

    private createRecord(project: string): ProjectRecord {
        const controller = new DiagnosticsController(project);
        const record: ProjectRecord = {
            project,
            controller,
            servers: new Map(),
            listeners: new Set(),
            controllerUnsubscribe: () => {},
            snapshot: controller.getSnapshot(),
            references: 0,
            active: true,
        };
        record.controllerUnsubscribe = controller.subscribe(() => this.commitControllerSnapshot(record));
        return record;
    }

    private createLease(record: ProjectRecord, ready: Promise<void>): ProjectDiagnosticsLease {
        let released = false;
        const subscriptions = new Set<() => void>();
        const getSnapshot = () => record.snapshot;
        const subscribe = (listener: () => void): (() => void) => {
            if (released || !record.active) throw new Error("cannot subscribe through a released project diagnostics lease");
            if (typeof listener !== "function") throw new TypeError("project diagnostics listener must be a function");
            if (record.listeners.size >= this.limits.maxSubscribersPerProject) {
                throw new RangeError(`project diagnostics cannot exceed ${this.limits.maxSubscribersPerProject} subscribers per project`);
            }
            const guardedListener = () => {
                try {
                    listener();
                } catch {
                    unsubscribe();
                }
            };
            record.listeners.add(guardedListener);
            const unsubscribe = once(() => {
                record.listeners.delete(guardedListener);
                subscriptions.delete(unsubscribe);
            });
            subscriptions.add(unsubscribe);
            return unsubscribe;
        };
        const release = once(() => {
            released = true;
            for (const unsubscribe of Array.from(subscriptions)) unsubscribe();
            this.releaseRecord(record);
        });
        return Object.freeze({
            project: record.project,
            controller: record.controller,
            ready,
            get released() {
                return released || !record.active;
            },
            getSnapshot,
            subscribe,
            release,
        });
    }

    private releaseRecord(record: ProjectRecord): void {
        if (!record.active || record.references === 0) return;
        record.references -= 1;
        if (record.references > 0) return;
        this.projects.delete(record.project);
        this.disposeRecord(record);
        if (this.projects.size === 0) this.stopSource();
    }

    private disposeRecord(record: ProjectRecord): void {
        if (!record.active) return;
        record.active = false;
        record.servers.clear();
        safeUnsubscribe(record.controllerUnsubscribe);
        record.controller.dispose();
        record.snapshot = record.controller.getSnapshot();
        this.notify(record);
        record.listeners.clear();
    }

    private commitControllerSnapshot(record: ProjectRecord): void {
        if (!record.active) return;
        record.snapshot = record.controller.getSnapshot();
        this.notify(record);
    }

    private notify(record: ProjectRecord): void {
        for (const listener of Array.from(record.listeners)) {
            try {
                listener();
            } catch {
                record.listeners.delete(listener);
            }
        }
    }

    private route(payload: LspDiagnosticsPayload): void {
        if (this.disposed) return;
        try {
            const record = this.projects.get(payload.project);
            if (!record?.active) return;
            const generation = record.servers.get(payload.language);
            if (generation === undefined) return;
            record.controller.publish(payload, generation);
        } catch {
            // The typed source validates payloads; runtime bypasses remain contained.
        }
    }

    private ensureSource(): Promise<void> {
        if (this.disposed) return containedRejected(new ProjectDiagnosticsRuntimeDisposedError());
        if (this.unsubscribeSource) return RESOLVED_VOID;
        if (this.sourcePromise) return this.sourcePromise;
        if (this.projects.size === 0) return RESOLVED_VOID;

        const generation = ++this.sourceGeneration;
        const listener: LspDiagnosticsListener = (payload) => {
            if (generation === this.sourceGeneration) this.route(payload);
        };
        let subscription: (() => void) | PromiseLike<() => void>;
        try {
            subscription = this.sourceSubscribe(listener);
        } catch (error) {
            this.sourceGeneration += 1;
            return containedRejected(error);
        }

        const pending = Promise.resolve(subscription).then((unsubscribe) => {
            if (typeof unsubscribe !== "function") throw new TypeError("project diagnostics source must return an unsubscribe function");
            const guarded = once(unsubscribe);
            if (this.disposed || this.projects.size === 0 || generation !== this.sourceGeneration) {
                safeUnsubscribe(guarded);
                return;
            }
            this.unsubscribeSource = guarded;
        });
        const tracked = pending
            .catch((error: unknown) => {
                if (generation === this.sourceGeneration) this.sourceGeneration += 1;
                throw error;
            })
            .finally(() => {
                if (this.sourcePromise === tracked) this.sourcePromise = null;
            });
        this.sourcePromise = tracked;
        void tracked.catch(() => {});
        return tracked;
    }

    private stopSource(): void {
        this.sourceGeneration += 1;
        this.sourcePromise = null;
        const unsubscribe = this.unsubscribeSource;
        this.unsubscribeSource = null;
        safeUnsubscribe(unsubscribe);
    }

    private issueServerGeneration(): DiagnosticsServerGeneration {
        if (!Number.isSafeInteger(this.nextServerGeneration) || this.nextServerGeneration <= 0) {
            throw new RangeError("project diagnostics server generation space is exhausted");
        }
        const generation = this.nextServerGeneration;
        this.nextServerGeneration += 1;
        return generation;
    }
}

export const projectDiagnosticsRuntime = new ProjectDiagnosticsRuntime();

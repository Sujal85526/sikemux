import type { ActiveProjectControllerSnapshot, ProjectControllerRuntime } from "./controllerRuntime";

export interface ProjectControllerRuntimePort {
    readonly subscribe: ProjectControllerRuntime["subscribe"];
    readonly getActiveSnapshot: ProjectControllerRuntime["getActiveSnapshot"];
    readonly start: ProjectControllerRuntime["start"];
    readonly reconcile: ProjectControllerRuntime["reconcile"];
    readonly refresh: ProjectControllerRuntime["refresh"];
    readonly stop: ProjectControllerRuntime["stop"];
}

export type ProjectControllerRuntimeLoader = () => Promise<ProjectControllerRuntimePort>;

const MAX_SUBSCRIBERS = 128;
const MAX_DESIRED_ROOTS = 128;
const EMPTY_ROOTS: readonly string[] = Object.freeze([]);

/**
 * Stable startup-facing facade for the lazily loaded project controller. It
 * remembers the latest reconciliation request and generation-gates every
 * asynchronous activation, including React StrictMode's start/stop replay.
 */
export class ProjectControllerBridge {
    private readonly listeners = new Set<() => void>();
    private readonly loader: ProjectControllerRuntimeLoader;
    private runtime: ProjectControllerRuntimePort | null = null;
    private loadPromise: Promise<ProjectControllerRuntimePort> | null = null;
    private startPromise: Promise<void> | null = null;
    private unsubscribe: (() => void) | null = null;
    private snapshot: ActiveProjectControllerSnapshot | null = null;
    private desiredRoots = EMPTY_ROOTS;
    private desiredActiveRoot: string | null = null;
    private generation = 0;
    private started = false;

    constructor(loader: ProjectControllerRuntimeLoader) {
        if (typeof loader !== "function") throw new TypeError("project controller loader must be a function");
        this.loader = loader;
    }

    subscribe = (listener: () => void): (() => void) => {
        if (typeof listener !== "function") throw new TypeError("project controller bridge subscriber must be a function");
        if (!this.listeners.has(listener) && this.listeners.size >= MAX_SUBSCRIBERS) {
            throw new RangeError(`project controller bridge cannot exceed ${MAX_SUBSCRIBERS} subscribers`);
        }
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    getActiveSnapshot = (): ActiveProjectControllerSnapshot | null => this.snapshot;

    start = (): Promise<void> => {
        if (this.started) return this.startPromise ?? Promise.resolve();
        this.started = true;
        const generation = ++this.generation;
        const started = this.activate(generation);
        this.startPromise = started;
        void started.finally(() => {
            if (this.generation === generation) this.startPromise = null;
        });
        return started;
    };

    reconcile = (roots: readonly string[], activeRoot: string | null): Promise<void> => {
        this.desiredRoots = Object.freeze(roots.slice(0, MAX_DESIRED_ROOTS));
        this.desiredActiveRoot = this.desiredRoots.includes(activeRoot ?? "") ? activeRoot : null;
        return this.started && this.runtime ? this.runtime.reconcile(this.desiredRoots, this.desiredActiveRoot) : Promise.resolve();
    };

    refresh = (root?: string): Promise<void> => {
        return this.started && this.runtime ? this.runtime.refresh(root) : Promise.resolve();
    };

    stop = (): void => {
        this.started = false;
        this.generation += 1;
        this.startPromise = null;
        this.detach();
        try {
            this.runtime?.stop();
        } catch {
            // Runtime teardown is best-effort during React cleanup.
        }
    };

    private async activate(generation: number): Promise<void> {
        try {
            const runtime = await this.load();
            if (!this.isCurrent(generation)) return;
            this.runtime = runtime;
            this.unsubscribe = runtime.subscribe(() => this.sync(runtime, generation));
            this.sync(runtime, generation);
            await runtime.start();
            if (!this.isCurrent(generation)) return;
            await runtime.reconcile(this.desiredRoots, this.desiredActiveRoot);
            if (this.isCurrent(generation)) this.sync(runtime, generation);
        } catch {
            if (!this.isCurrent(generation)) return;
            this.started = false;
            this.generation += 1;
            this.detach();
            try {
                this.runtime?.stop();
            } catch {
                // A failed lazy activation must remain retryable.
            }
        }
    }

    private load(): Promise<ProjectControllerRuntimePort> {
        this.loadPromise ??= this.loader().catch((error: unknown) => {
            this.loadPromise = null;
            throw error;
        });
        return this.loadPromise;
    }

    private isCurrent(generation: number): boolean {
        return this.started && this.generation === generation;
    }

    private sync(runtime: ProjectControllerRuntimePort, generation: number): void {
        if (!this.isCurrent(generation) || this.runtime !== runtime) return;
        const next = runtime.getActiveSnapshot();
        if (this.snapshot === next) return;
        this.snapshot = next;
        this.publish();
    }

    private detach(): void {
        const unsubscribe = this.unsubscribe;
        this.unsubscribe = null;
        if (unsubscribe) {
            try {
                unsubscribe();
            } catch {
                // A bad adapter cannot escape renderer teardown.
            }
        }
        if (this.snapshot === null) return;
        this.snapshot = null;
        this.publish();
    }

    private publish(): void {
        for (const listener of Array.from(this.listeners)) {
            try {
                listener();
            } catch {
                this.listeners.delete(listener);
            }
        }
    }
}

export const projectControllerBridge = new ProjectControllerBridge(() =>
    import("./controllerRuntime").then(({ projectControllerRuntime }) => projectControllerRuntime),
);

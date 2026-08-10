import { performanceTelemetry } from "../lib/performance";

export interface ProjectControllerServices<Config, Worktree> {
    loadConfig: (cwd: string) => Promise<Config>;
    loadWorktrees: (cwd: string) => Promise<readonly Worktree[]>;
    newWatchLeaseToken: () => string;
    watchStart: (cwd: string, token: string) => void | PromiseLike<void>;
    watchStop: (token: string) => void | PromiseLike<void>;
}

export interface ProjectControllerSnapshot<Config, Worktree> {
    readonly cwd: string;
    readonly status: "idle" | "loading" | "ready" | "error";
    readonly config: Config | null;
    readonly worktrees: readonly Worktree[];
    readonly error: string | null;
    readonly revision: number;
    readonly retainCount: number;
}

type Listener = () => void;
const WATCH_STOP_MAX_ATTEMPTS = 3;
const WATCH_LEASE_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === "string") return error;
    return "project refresh failed";
}

function requireWatchLeaseToken(value: unknown): string {
    if (typeof value !== "string" || !WATCH_LEASE_TOKEN.test(value)) throw new TypeError("project watcher returned an invalid lease token");
    return value;
}

/** Runtime owner for project-scoped services shared by every session at one cwd. */
export class ProjectController<Config, Worktree> {
    private readonly listeners = new Set<Listener>();
    private snapshotValue: ProjectControllerSnapshot<Config, Worktree>;
    private generation = 0;
    private refreshPromise: Promise<void> | null = null;
    private refreshQueued = false;
    private watchTransitionPromise: Promise<void> | null = null;
    private watchTransitionGeneration = 0;
    private watchFailedGeneration: number | null = null;
    private watchDesired = false;
    private watchLeaseToken: string | null = null;
    private watchLeaseActive = false;
    private watchLeaseUncertain = false;
    private watchError: string | null = null;
    private refreshError: string | null = null;
    private started = false;
    private disposed = false;

    constructor(
        readonly cwd: string,
        private readonly services: ProjectControllerServices<Config, Worktree>,
    ) {
        this.snapshotValue = {
            cwd,
            status: "idle",
            config: null,
            worktrees: [],
            error: null,
            revision: 0,
            retainCount: 0,
        };
    }

    getSnapshot = (): ProjectControllerSnapshot<Config, Worktree> => this.snapshotValue;

    subscribe = (listener: Listener): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    retain(): Promise<void> {
        if (this.disposed) throw new Error("cannot retain a disposed project controller");
        const retainCount = this.snapshotValue.retainCount + 1;
        this.patch({ retainCount });
        if (this.started) return this.refreshPromise ?? Promise.resolve();
        this.started = true;
        this.requestWatchState(true);
        return this.refresh();
    }

    release(): void {
        if (this.snapshotValue.retainCount === 0) return;
        const retainCount = this.snapshotValue.retainCount - 1;
        this.patch({ retainCount });
        if (retainCount !== 0 || !this.started) return;
        this.started = false;
        this.generation += 1;
        this.refreshQueued = false;
        this.requestWatchState(false);
    }

    refresh(): Promise<void> {
        if (this.disposed || !this.started) return Promise.resolve();
        if (this.refreshPromise) {
            if (!this.refreshQueued) {
                this.refreshQueued = true;
                performanceTelemetry.incrementCounter("project.refresh.queued");
            }
            return this.refreshPromise;
        }

        const drain = async () => {
            do {
                this.refreshQueued = false;
                const generation = ++this.generation;
                this.refreshError = null;
                this.patch({ status: this.watchError ? "error" : "loading", error: this.watchError });
                const span = performanceTelemetry.startTrace("project.refresh");
                const [configResult, worktreeResult] = await Promise.allSettled([
                    this.services.loadConfig(this.cwd),
                    this.services.loadWorktrees(this.cwd),
                ]);

                if (this.disposed || !this.started || generation !== this.generation) {
                    const recorded = performanceTelemetry.endSpan(span, { outcome: "cancelled" });
                    if (recorded) performanceTelemetry.recordLatency("project.refresh", recorded.durationMs);
                    performanceTelemetry.incrementCounter("project.refresh.cancelled");
                    continue;
                }

                const config = configResult.status === "fulfilled" ? configResult.value : this.snapshotValue.config;
                const worktrees = worktreeResult.status === "fulfilled" ? worktreeResult.value : this.snapshotValue.worktrees;
                const error =
                    configResult.status === "rejected"
                        ? errorMessage(configResult.reason)
                        : worktreeResult.status === "rejected"
                          ? errorMessage(worktreeResult.reason)
                          : null;
                this.refreshError = error;
                const visibleError = this.watchError ?? this.refreshError;
                this.patch({
                    config,
                    worktrees,
                    error: visibleError,
                    status: visibleError ? "error" : "ready",
                    revision: this.snapshotValue.revision + 1,
                });
                const recorded = performanceTelemetry.endSpan(span, { outcome: error ? "error" : "success" });
                if (recorded) performanceTelemetry.recordLatency("project.refresh", recorded.durationMs);
            } while (this.refreshQueued && this.started && !this.disposed);
        };

        const refreshPromise = drain().finally(() => {
            if (this.refreshPromise === refreshPromise) this.refreshPromise = null;
        });
        this.refreshPromise = refreshPromise;
        return refreshPromise;
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.started = false;
        this.generation += 1;
        this.refreshQueued = false;
        // Advance the transition generation even after release: a pending start
        // must be compensated if it succeeds after this controller is disposed.
        this.requestWatchState(false);
        this.listeners.clear();
        this.watchError = null;
        this.refreshError = null;
        this.snapshotValue = { ...this.snapshotValue, status: "idle", error: null, retainCount: 0 };
    }

    private requestWatchState(active: boolean): void {
        this.watchDesired = active;
        this.watchTransitionGeneration = this.watchTransitionGeneration >= Number.MAX_SAFE_INTEGER ? 1 : this.watchTransitionGeneration + 1;
        this.watchFailedGeneration = null;
        this.ensureWatchTransition();
    }

    private ensureWatchTransition(): void {
        if (this.watchTransitionPromise || this.watchStateConverged() || this.watchFailedGeneration === this.watchTransitionGeneration) {
            return;
        }

        const transition = this.drainWatchTransitions().finally(() => {
            if (this.watchTransitionPromise !== transition) return;
            this.watchTransitionPromise = null;
            // A retain/release can land after the drain observes convergence but
            // before this finally callback. Recheck without issuing a duplicate
            // transition for a failure in the same desired-state generation.
            this.ensureWatchTransition();
        });
        this.watchTransitionPromise = transition;
        void transition.catch(() => {
            // Service failures are handled inside the drain. This backstop also
            // contains an unexpected subscriber exception during error publish.
        });
    }

    private async drainWatchTransitions(): Promise<void> {
        while (!this.watchStateConverged()) {
            const generation = this.watchTransitionGeneration;
            if (this.watchLeaseToken === null) {
                let token: string;
                try {
                    token = requireWatchLeaseToken(this.services.newWatchLeaseToken());
                } catch (error) {
                    performanceTelemetry.incrementCounter("project.watch.start.failures");
                    if (generation !== this.watchTransitionGeneration || !this.watchDesired) continue;
                    this.watchFailedGeneration = generation;
                    if (!this.disposed && this.started) {
                        this.watchError = errorMessage(error);
                        this.publishServiceStatus();
                    }
                    return;
                }
                this.watchLeaseToken = token;
                this.watchLeaseActive = false;
                this.watchLeaseUncertain = true;
                if (!(await this.startWatchLease(token, generation))) return;
                continue;
            }

            if (this.watchLeaseUncertain && this.watchDesired) {
                if (!(await this.startWatchLease(this.watchLeaseToken, generation))) return;
                continue;
            }

            // Once a stop has started, finish compensating that exact lease even
            // if a retain arrives meanwhile. The opaque token makes retries
            // idempotent after a lost successful response; only then may the
            // latest desired state acquire a replacement lease.
            const token = this.watchLeaseToken;
            const stopped = await this.stopWatchLease(token);
            if (!stopped) {
                if (generation !== this.watchTransitionGeneration) continue;
                this.watchFailedGeneration = this.watchTransitionGeneration;
                if (!this.disposed && this.started) {
                    this.watchError = "project watcher stop failed";
                    this.publishServiceStatus();
                }
                return;
            }
        }
    }

    private watchStateConverged(): boolean {
        if (this.watchLeaseToken !== null && (!this.watchLeaseActive || this.watchLeaseUncertain)) return false;
        return this.watchLeaseActive === this.watchDesired;
    }

    private async startWatchLease(token: string, generation: number): Promise<boolean> {
        try {
            await this.services.watchStart(this.cwd, token);
        } catch (error) {
            performanceTelemetry.incrementCounter("project.watch.start.failures");
            const compensated = await this.stopWatchLease(token);
            if (compensated) performanceTelemetry.incrementCounter("project.watch.start.compensations");
            if (generation !== this.watchTransitionGeneration) return true;
            this.watchFailedGeneration = generation;
            if (!this.disposed && this.started) {
                this.watchError = errorMessage(error);
                this.publishServiceStatus();
            }
            return false;
        }
        this.watchLeaseActive = true;
        this.watchLeaseUncertain = false;
        if (this.watchError !== null) {
            this.watchError = null;
            this.publishServiceStatus();
        }
        return true;
    }

    private async stopWatchLease(token: string): Promise<boolean> {
        for (let attempt = 1; attempt <= WATCH_STOP_MAX_ATTEMPTS; attempt += 1) {
            try {
                await this.services.watchStop(token);
                if (this.watchLeaseToken === token) {
                    this.watchLeaseToken = null;
                    this.watchLeaseActive = false;
                    this.watchLeaseUncertain = false;
                }
                return true;
            } catch {
                performanceTelemetry.incrementCounter("project.watch.stop.failures");
                if (attempt < WATCH_STOP_MAX_ATTEMPTS) performanceTelemetry.incrementCounter("project.watch.stop.retries");
            }
        }
        performanceTelemetry.incrementCounter("project.watch.stop.exhausted");
        if (this.watchLeaseToken === token) this.watchLeaseUncertain = true;
        return false;
    }

    private publishServiceStatus(): void {
        if (this.disposed || !this.started) return;
        const error = this.watchError ?? this.refreshError;
        this.patch({
            error,
            status: error ? "error" : this.refreshPromise ? "loading" : this.snapshotValue.revision > 0 ? "ready" : "loading",
        });
    }

    private patch(patch: Partial<ProjectControllerSnapshot<Config, Worktree>>): void {
        this.snapshotValue = { ...this.snapshotValue, ...patch };
        this.listeners.forEach((listener) => listener());
    }
}

export class ProjectControllerRegistry<Config, Worktree> {
    private readonly controllers = new Map<string, ProjectController<Config, Worktree>>();

    constructor(private readonly services: ProjectControllerServices<Config, Worktree>) {}

    acquire(cwd: string): { controller: ProjectController<Config, Worktree>; ready: Promise<void>; release: () => void } {
        let controller = this.controllers.get(cwd);
        if (!controller) {
            controller = new ProjectController(cwd, this.services);
            this.controllers.set(cwd, controller);
        }
        const ready = controller.retain();
        let released = false;
        return {
            controller,
            ready,
            release: () => {
                if (released) return;
                released = true;
                controller!.release();
            },
        };
    }

    get(cwd: string): ProjectController<Config, Worktree> | undefined {
        return this.controllers.get(cwd);
    }

    dispose(): void {
        this.controllers.forEach((controller) => controller.dispose());
        this.controllers.clear();
    }
}

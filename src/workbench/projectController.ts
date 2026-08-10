import { performanceTelemetry } from "../lib/performance";

export interface ProjectControllerServices<Config, Worktree> {
    loadConfig: (cwd: string) => Promise<Config>;
    loadWorktrees: (cwd: string) => Promise<readonly Worktree[]>;
    watchStart: (cwd: string) => void | Promise<void>;
    watchStop: (cwd: string) => void | Promise<void>;
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

function errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === "string") return error;
    return "project refresh failed";
}

/** Runtime owner for project-scoped services shared by every session at one cwd. */
export class ProjectController<Config, Worktree> {
    private readonly listeners = new Set<Listener>();
    private snapshotValue: ProjectControllerSnapshot<Config, Worktree>;
    private generation = 0;
    private refreshPromise: Promise<void> | null = null;
    private refreshQueued = false;
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
        void Promise.resolve(this.services.watchStart(this.cwd)).catch((error) => {
            if (!this.disposed) this.patch({ status: "error", error: errorMessage(error) });
        });
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
        void Promise.resolve(this.services.watchStop(this.cwd)).catch(() => {});
    }

    refresh(): Promise<void> {
        if (this.disposed || !this.started) return Promise.resolve();
        if (this.refreshPromise) {
            this.refreshQueued = true;
            return this.refreshPromise;
        }

        const generation = ++this.generation;
        this.patch({ status: "loading", error: null });
        const span = performanceTelemetry.startTrace("project.refresh");
        this.refreshPromise = Promise.allSettled([this.services.loadConfig(this.cwd), this.services.loadWorktrees(this.cwd)])
            .then(([configResult, worktreeResult]) => {
                if (this.disposed || !this.started || generation !== this.generation) return;
                const config = configResult.status === "fulfilled" ? configResult.value : this.snapshotValue.config;
                const worktrees = worktreeResult.status === "fulfilled" ? worktreeResult.value : this.snapshotValue.worktrees;
                const error =
                    configResult.status === "rejected"
                        ? errorMessage(configResult.reason)
                        : worktreeResult.status === "rejected"
                          ? errorMessage(worktreeResult.reason)
                          : null;
                this.patch({
                    config,
                    worktrees,
                    error,
                    status: error ? "error" : "ready",
                    revision: this.snapshotValue.revision + 1,
                });
                const recorded = performanceTelemetry.endSpan(span, { outcome: error ? "error" : "success" });
                if (recorded) performanceTelemetry.recordLatency("project.refresh", recorded.durationMs);
            })
            .finally(() => {
                if (generation === this.generation) {
                    const queued = this.refreshQueued;
                    this.refreshPromise = null;
                    this.refreshQueued = false;
                    if (queued && this.started && !this.disposed) void this.refresh();
                } else {
                    performanceTelemetry.endSpan(span, { outcome: "cancelled" });
                    this.refreshPromise = null;
                }
            });
        return this.refreshPromise;
    }

    dispose(): void {
        if (this.disposed) return;
        const wasStarted = this.started;
        this.disposed = true;
        this.started = false;
        this.generation += 1;
        this.refreshQueued = false;
        if (wasStarted) void Promise.resolve(this.services.watchStop(this.cwd)).catch(() => {});
        this.listeners.clear();
        this.snapshotValue = { ...this.snapshotValue, status: "idle", retainCount: 0 };
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

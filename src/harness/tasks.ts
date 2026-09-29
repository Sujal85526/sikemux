import type { TaskExecutionBackend, TaskExecutionRequest, TaskTerminalSurface } from "../tasks/runtime";
import type { HarnessEvents } from "./events";

export interface HarnessRun {
    executionId: string;
    taskId: string;
    project: string;
    status: "awaiting-trust" | "starting" | "running" | "completed" | "failed" | "stopping" | "stopped";
    label?: string;
    command?: string;
    ptyId?: number;
    exitCode?: number;
    signal?: string | null;
    error?: string;
    previewUrl?: string;
}

export type HarnessLaunchRequest = Omit<TaskExecutionRequest, "executionId" | "terminalKey">;

export interface HarnessPrepared {
    request: HarnessLaunchRequest;
    previewUrl?: string;
}

/** Everything a launch needs that may wait on the person, such as trusting sikemux.json. */
export type HarnessPrepare = (executionId: string, signal: AbortSignal) => Promise<HarnessPrepared> | HarnessPrepared;

export interface HarnessLaunch {
    executionId: string;
    started: Promise<HarnessRun>;
}

interface Entry {
    run: HarnessRun;
    agentId?: string;
    request?: HarnessLaunchRequest;
    started: Promise<HarnessRun>;
    abort: AbortController;
    stop?: Promise<HarnessRun>;
}

const ACTIVE: HarnessRun["status"][] = ["awaiting-trust", "starting", "running", "stopping"];
const HISTORY_KEY = "sikemux.harness.started";

export type HarnessHistory = Pick<Storage, "getItem" | "setItem">;

function readHistory(history: HarnessHistory | undefined): string[] {
    try {
        const stored: unknown = JSON.parse(history?.getItem(HISTORY_KEY) ?? "[]");
        return Array.isArray(stored) ? stored.filter((entry): entry is string => typeof entry === "string") : [];
    } catch {
        return [];
    }
}

export class HarnessTasks {
    private readonly entries = new Map<string, Entry>();
    private readonly keys = new Map<string, { taskId: string; executionId: string }>();
    private readonly earlier: ReadonlySet<string>;
    private readonly started: Set<string>;

    /** `history` outlives a reload of the window, which stops every task and forgets its runs. */
    constructor(
        private readonly backend: TaskExecutionBackend,
        private readonly surface: TaskTerminalSurface,
        private readonly events: HarnessEvents,
        private readonly history?: HarnessHistory,
    ) {
        this.earlier = new Set(readHistory(history));
        this.started = new Set(this.earlier);
    }

    startedBeforeReload(project: string, taskId: string): boolean {
        return this.earlier.has(JSON.stringify([project, taskId])) && !this.latest(project, taskId);
    }

    list(project: string): HarnessRun[] {
        return [...this.entries.values()].filter((entry) => entry.run.project === project).map((entry) => ({ ...entry.run }));
    }

    get(project: string, executionId: string): HarnessRun {
        return { ...this.entry(project, executionId).run };
    }

    latest(project: string, taskId: string): HarnessRun | undefined {
        const runs = this.list(project).filter((run) => run.taskId === taskId);
        return runs.at(-1);
    }

    launchRequest(project: string, taskId: string): HarnessLaunchRequest | undefined {
        return [...this.entries.values()].filter(({ run, request }) => run.project === project && run.taskId === taskId && request).at(-1)?.request;
    }

    existing(project: string, taskId: string, key: string): HarnessLaunch | undefined {
        const previous = this.keys.get(JSON.stringify([project, key]));
        if (!previous) return undefined;
        if (previous.taskId !== taskId) throw new Error("idempotencyKey was already used for another task");
        return this.handle(this.entry(project, previous.executionId));
    }

    /** With `replace`, a new execution starts even while an earlier one is still active. */
    start(
        project: string,
        taskId: string,
        key: string,
        prepare: HarnessPrepare,
        options: { agentId?: string; replace?: boolean } = {},
    ): HarnessLaunch {
        const previous = this.existing(project, taskId, key);
        if (previous) return previous;
        if (this.keys.size >= 256) throw new Error("Harness idempotency capacity reached; restart Sikemux to clear run history");
        const active = options.replace
            ? undefined
            : [...this.entries.values()].find(({ run }) => run.project === project && run.taskId === taskId && ACTIVE.includes(run.status));
        if (active) {
            this.keys.set(JSON.stringify([project, key]), { taskId, executionId: active.run.executionId });
            return this.handle(active);
        }
        if (this.entries.size >= 128) throw new Error("Harness run capacity reached; restart Sikemux to clear run history");
        const executionId = crypto.randomUUID();
        const run: HarnessRun = { executionId, taskId, project, status: "starting" };
        const entry: Entry = { run, agentId: options.agentId, abort: new AbortController(), started: Promise.resolve(run) };
        this.entries.set(executionId, entry);
        this.keys.set(JSON.stringify([project, key]), { taskId, executionId });
        this.remember(project, taskId);
        this.publish(run);
        entry.started = this.launch(entry, prepare);
        void entry.started.catch(() => {});
        return this.handle(entry);
    }

    awaitTrust(project: string, executionId: string): void {
        const { run } = this.entry(project, executionId);
        if (run.status !== "starting") return;
        run.status = "awaiting-trust";
        this.publish(run);
    }

    private handle(entry: Entry): HarnessLaunch {
        return { executionId: entry.run.executionId, started: entry.started.then(() => ({ ...entry.run })) };
    }

    private async prepare(entry: Entry, prepare: HarnessPrepare): Promise<HarnessPrepared | undefined> {
        const { run } = entry;
        try {
            const prepared = await prepare(run.executionId, entry.abort.signal);
            return entry.abort.signal.aborted ? undefined : prepared;
        } catch (error) {
            if (entry.abort.signal.aborted) return undefined;
            run.status = "failed";
            run.error = error instanceof Error ? error.message : String(error);
            this.publish(run);
            throw error;
        }
    }

    private async launch(entry: Entry, prepare: HarnessPrepare): Promise<HarnessRun> {
        const { run } = entry;
        const prepared = await this.prepare(entry, prepare);
        if (!prepared) return { ...run };
        entry.request = prepared.request;
        run.label = prepared.request.label;
        run.command = prepared.request.command;
        run.previewUrl = prepared.previewUrl;
        if (run.status === "awaiting-trust") {
            run.status = "starting";
            this.publish(run);
        }
        const request: TaskExecutionRequest = {
            ...prepared.request,
            executionId: run.executionId,
            terminalKey: JSON.stringify(["harness", run.project, run.taskId]),
        };
        try {
            const started = await this.backend.start(request);
            run.ptyId = started.ptyId;
            run.status = "running";
            this.publish(run);
            void Promise.resolve(started.completion).then(
                (exit) => {
                    run.exitCode = exit.code;
                    run.signal = exit.signal;
                    if (run.status !== "stopped") run.status = run.status === "stopping" ? "stopped" : exit.code === 0 ? "completed" : "failed";
                    this.publish(run);
                },
                () => {
                    run.status = "failed";
                    run.error = "Task completion could not be observed";
                    this.publish(run);
                },
            );
            await this.surface.open({ ...request, ptyId: started.ptyId, agentId: entry.agentId, signal: entry.abort.signal });
            return { ...run };
        } catch (error) {
            if (run.ptyId !== undefined)
                await Promise.resolve(this.backend.stop(run.ptyId)).catch(() => {
                    run.error = "Task launch failed and process cleanup failed";
                });
            run.status = "failed";
            run.error ??= "Task could not be started or its terminal could not be opened";
            this.publish(run);
            throw error;
        }
    }

    stop(project: string, executionId: string): Promise<HarnessRun> {
        const entry = this.entry(project, executionId);
        if (entry.stop) return entry.stop;
        const operation = async () => {
            const { run } = entry;
            if (!entry.request && ["awaiting-trust", "starting"].includes(run.status)) {
                entry.abort.abort();
                run.status = "stopped";
                this.publish(run);
                return { ...run };
            }
            await entry.started.catch(() => {});
            if (run.ptyId === undefined || ["completed", "stopped"].includes(run.status) || (run.status === "failed" && run.exitCode !== undefined))
                return { ...run };
            run.status = "stopping";
            this.publish(run);
            try {
                await this.backend.stop(run.ptyId);
                run.status = "stopped";
                this.publish(run);
                return { ...run };
            } catch (error) {
                run.status = "failed";
                run.error = "Task could not be stopped";
                this.publish(run);
                throw error;
            }
        };
        entry.stop = operation().finally(() => {
            entry.stop = undefined;
        });
        return entry.stop;
    }

    output(ptyId: number): void {
        const entry = [...this.entries.values()].find(({ run }) => run.ptyId === ptyId);
        if (entry) this.events.publish({ project: entry.run.project, kind: "task.output", executionId: entry.run.executionId });
    }

    closeProject(project: string): void {
        for (const run of this.list(project)) void this.stop(project, run.executionId).catch(() => {});
    }

    closeAgent(agentId: string): void {
        for (const { run, agentId: owner } of this.entries.values())
            if (owner === agentId) void this.stop(run.project, run.executionId).catch(() => {});
    }

    private entry(project: string, executionId: string): Entry {
        const entry = this.entries.get(executionId);
        if (!entry || entry.run.project !== project) throw new Error("Task execution does not belong to this project");
        return entry;
    }

    private remember(project: string, taskId: string): void {
        const key = JSON.stringify([project, taskId]);
        if (this.started.has(key) || this.started.size >= 256) return;
        this.started.add(key);
        try {
            this.history?.setItem(HISTORY_KEY, JSON.stringify([...this.started]));
        } catch {
            this.started.delete(key);
        }
    }

    private publish(run: HarnessRun): void {
        this.events.publish({ project: run.project, kind: `task.${run.status}`, executionId: run.executionId });
    }
}

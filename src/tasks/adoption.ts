import type { CoreSession, CoreTaskInfo } from "../api/coreSessions";
import type { HarnessAdoption } from "../harness/tasks";
import type { TaskExecutionStart } from "./runtime";
import type { ResolvedTaskDefinition } from "./taskRegistry";

/** Where a task the core kept goes back to: the command deck, or the harness that an agent started it through. */
export type TaskOrigin = { readonly kind: "deck" | "harness"; readonly project: string; readonly taskId: string };

export function taskOrigin(task: CoreTaskInfo): TaskOrigin | null {
    let key: unknown;
    try {
        key = JSON.parse(task.terminalKey);
    } catch {
        return null;
    }
    if (!Array.isArray(key) || key.length !== 3 || key[1] !== task.project || key[2] !== task.taskId) return null;
    if (key[0] === "task") return { kind: "deck", project: task.project, taskId: task.taskId };
    if (key[0] === "harness") return { kind: "harness", project: task.project, taskId: task.taskId };
    return null;
}

export interface TaskAdoptionTargets {
    watch(ptyId: number): Promise<TaskExecutionStart>;
    adoptDeckTask(task: ResolvedTaskDefinition, executionId: string, started: TaskExecutionStart): Promise<void>;
    adoptHarnessRun(adoption: HarnessAdoption, started: TaskExecutionStart): void;
}

/* Command-deck tasks come back only while they run; the deck shows one
   running task per project and nothing of finished ones. Harness runs come
   back finished too, so an agent can still read how they ended. */
export async function adoptCoreTasks(sessions: readonly CoreSession[], targets: TaskAdoptionTargets): Promise<number> {
    let running = 0;
    for (const session of sessions) {
        const task = session.kind === "task" ? session.task : null;
        const origin = task && taskOrigin(task);
        if (!task || !origin || (origin.kind === "deck" && !session.running)) continue;
        let started: TaskExecutionStart;
        try {
            started = await targets.watch(session.id);
        } catch {
            continue;
        }
        const request = {
            taskId: task.taskId,
            label: task.label,
            project: task.project,
            source: task.source,
            command: task.command,
            cwd: task.cwd,
            env: {},
        };
        if (origin.kind === "deck") {
            void targets.adoptDeckTask({ ...request, id: task.taskId }, task.executionId, started).catch(() => {});
        } else {
            targets.adoptHarnessRun(
                {
                    executionId: task.executionId,
                    terminalKey: task.terminalKey,
                    request: { ...request, cols: 120, rows: 30 },
                    agentId: task.agentId ?? undefined,
                    running: session.running,
                },
                started,
            );
        }
        if (session.running) running += 1;
    }
    return running;
}

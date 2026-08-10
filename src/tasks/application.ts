import { joinPath } from "../lib/paths";
import type { ProjectTask } from "../projectConfig";
import { openTaskTerminal } from "../state/commands";
import { TaskRegistry, type TaskDefinitionInput, type TaskRegistrySnapshot } from "./taskRegistry";
import { TaskRuntime } from "./runtime";
import { NativeTaskExecutionBackend, WorkbenchTaskTerminalSurface, taskPtyBindings } from "./nativeRuntime";

export function projectTaskDefinitions(project: string, tasks: readonly ProjectTask[]): readonly TaskDefinitionInput[] {
    return Object.freeze(
        tasks.map((task) =>
            Object.freeze({
                id: task.id,
                label: task.label,
                project,
                command: task.command,
                cwd: task.cwd === "." ? project : joinPath(project, task.cwd),
                env: Object.freeze({ ...task.env }),
            }),
        ),
    );
}

export const appTaskRegistry = new TaskRegistry();
export const appTaskRuntime = new TaskRuntime({
    registry: appTaskRegistry,
    backend: new NativeTaskExecutionBackend(),
    surface: new WorkbenchTaskTerminalSurface(taskPtyBindings, openTaskTerminal),
});

export function replaceActiveProjectTasks(project: string, tasks: readonly ProjectTask[]): void {
    appTaskRegistry.replaceSource("project", projectTaskDefinitions(project, tasks));
}

export function clearActiveProjectTasks(): void {
    appTaskRegistry.replaceSource("project", []);
}

export function subscribeAppTasks(listener: () => void): () => void {
    return appTaskRegistry.subscribe(listener);
}

export function getAppTaskSnapshot(): TaskRegistrySnapshot {
    return appTaskRegistry.getSnapshot();
}

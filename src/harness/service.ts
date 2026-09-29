import { invokeCommand } from "../api/invoke";
import { browserApi } from "../api/browser";
import { loadProjectConfig } from "../projects/projectConfig";
import { trustProjectConfig } from "../projects/projectConfigRuntime";
import { confirmDialog } from "../state/dialog";
import { joinPath } from "../lib/paths";
import { collectPanes } from "../state/layout";
import { agentIdsOf } from "../state/selectors";
import { useStore, setState } from "../state/store";
import * as commands from "../state/commands";
import { appTaskRuntime } from "../tasks/application";
import { NativeTaskExecutionBackend, WorkbenchTaskTerminalSurface, taskPtyBindings } from "../tasks/nativeRuntime";
import { HarnessEvents } from "./events";
import { HarnessTasks, type HarnessLaunch, type HarnessLaunchRequest, type HarnessPrepared, type HarnessRun } from "./tasks";

export interface HarnessRequest {
    id: string;
    project: string;
    agentId: string | null;
    method: string;
    params: Record<string, unknown>;
}

export const harnessEvents = new HarnessEvents();

function preserveFocus<T>(operation: () => T): T {
    const before = useStore.getState();
    try {
        return operation();
    } finally {
        const current = useStore.getState();
        const sessions = { ...current.sessions };
        for (const [id, session] of Object.entries(sessions)) {
            const previous = before.sessions[id];
            if (previous) sessions[id] = { ...session, activeWindowId: previous.activeWindowId };
        }
        setState({
            activeSessionId: before.activeSessionId,
            zoomedPaneId: before.zoomedPaneId,
            pickerOpen: before.pickerOpen,
            settingsOpen: before.settingsOpen,
            sessions,
        });
    }
}

/* A task an agent started goes on that agent's desk. One started with no agent
   behind it, or by one that has since closed, gets a tab in the workspace. */
export const harnessTasks = new HarnessTasks(
    new NativeTaskExecutionBackend(),
    new WorkbenchTaskTerminalSurface(taskPtyBindings, (request) =>
        request.agentId && useStore.getState().agents[request.agentId]
            ? commands.openDeskTerminal(request.agentId, request)
            : preserveFocus(() => commands.openTaskTerminal(request)),
    ),
    harnessEvents,
);

function text(params: Record<string, unknown>, key: string, required = true): string | undefined {
    const value = params[key];
    if (value === undefined && !required) return undefined;
    if (typeof value !== "string" || !value.trim() || value.length > 4096) throw new Error(`${key} must be nonempty text of at most 4096 characters`);
    return value;
}

function integer(params: Record<string, unknown>, key: string, fallback: number, max: number, min = 0): number {
    const value = params[key] ?? fallback;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
        throw new Error(`${key} must be an integer between ${min} and ${max}`);
    return value;
}

function projectSession(request: HarnessRequest) {
    const state = useStore.getState();
    const session = Object.values(state.sessions).find((session) => session.kind === "project" && session.cwd === request.project);
    if (!session) throw new Error("Project is not open in Sikemux");
    if (request.agentId && !agentIdsOf(state, session.id).includes(request.agentId)) throw new Error("Agent does not belong to this project");
    return session;
}

interface OutputQuery {
    cursor: number;
    limit: number;
    tail?: number;
    search?: string;
    context: number;
    plain: boolean;
}

interface OutputPage {
    bytes: number[];
    cursor: number;
    end: number;
    hasMore: boolean;
    truncated: boolean;
    matches?: number;
}

function readOutput(ptyId: number, query: OutputQuery): Promise<OutputPage> {
    return invokeCommand<OutputPage>("harness_task_output", { id: ptyId, query });
}

function executionFor(project: string, params: Record<string, unknown>): string {
    const executionId = text(params, "executionId", false);
    const taskId = text(params, "taskId", false);
    if (executionId && taskId) throw new Error("Pass either executionId or taskId, not both");
    if (executionId) return executionId;
    if (!taskId) throw new Error("executionId or taskId is required");
    const latest = harnessTasks.latest(project, taskId);
    if (!latest) throw new Error(`Task ${taskId} has not been started from this app session; start it with task_start`);
    return latest.executionId;
}

async function configuredTask(project: string, taskId: string) {
    const config = await loadProjectConfig(project);
    if (config.status === "absent") throw new Error("Project has no sikemux.json; add one that defines tasks");
    if (config.status === "invalid")
        throw new Error(`sikemux.json is invalid: ${config.errors.map((error) => `${error.path} ${error.message}`).join(" · ")}`);
    const task = config.config.tasks.find((task) => task.id === taskId);
    if (!task) throw new Error("Task is not defined in sikemux.json");
    return { config, task };
}

async function launchConfigured(request: HarnessRequest, taskId: string, key: string, replace = false): Promise<HarnessLaunch> {
    const { project } = request;
    const existing = replace ? undefined : harnessTasks.existing(project, taskId, key);
    if (existing) return existing;
    const { config, task } = await configuredTask(project, taskId);
    const previous = replace ? harnessTasks.latest(project, taskId) : undefined;
    const prepare = async (executionId: string, signal: AbortSignal): Promise<HarnessPrepared> => {
        const trusted = await trustProjectConfig(config, (ask) => {
            harnessTasks.awaitTrust(project, executionId);
            return confirmDialog(ask);
        });
        if (!trusted) throw new Error("Project configuration was not approved");
        const fresh = await loadProjectConfig(project);
        if (fresh.status !== "valid" || fresh.fingerprint !== config.fingerprint) throw new Error("Project configuration changed; inspect and retry");
        if (signal.aborted) throw signal.reason;
        projectSession(request);
        const userTask = appTaskRuntime.getSnapshot(project);
        if (userTask?.task?.id === taskId && ["running", "stopping"].includes(userTask.status))
            throw new Error("This task is already running through the command deck");
        if (previous) await harnessTasks.stop(project, previous.executionId);
        return {
            request: {
                taskId,
                project,
                source: "project",
                label: task.label,
                command: task.command,
                cwd: task.cwd === "." ? project : joinPath(project, task.cwd),
                env: task.env,
                cols: 120,
                rows: 30,
            },
            previewUrl: config.config.preview?.command === task.command ? config.config.preview.url : undefined,
        };
    };
    return harnessTasks.start(project, taskId, key, prepare, { agentId: request.agentId ?? undefined, replace });
}

const COMMAND_TASK_PREFIX = "sh:";

function commandCwd(value: string | undefined): string {
    const normalized = (value ?? ".").replaceAll("\\", "/").replace(/\/+$/, "");
    const parts = normalized.split("/").filter((part) => part !== ".");
    if (
        normalized.startsWith("/") ||
        normalized.startsWith("~") ||
        /^[A-Za-z]:/.test(normalized) ||
        parts.some((part) => part === "" || part === "..")
    )
        throw new Error("cwd must be a directory inside the project, relative to it");
    return parts.join("/");
}

/* The id comes from the command and its directory, so starting the same command
   again while it runs finds that run instead of launching a second copy. */
function commandTaskId(command: string, cwd: string, label: string | undefined): string {
    let hash = 0x811c9dc5;
    for (const byte of new TextEncoder().encode(`${cwd}\0${command}`)) hash = Math.imul(hash ^ byte, 0x01000193);
    const slug = (label ?? command)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 32)
        .replace(/-+$/, "");
    return `${COMMAND_TASK_PREFIX}${slug || "command"}-${(hash >>> 0).toString(16).padStart(8, "0").slice(0, 6)}`;
}

function commandLaunch(request: HarnessRequest, params: Record<string, unknown>): HarnessLaunchRequest {
    const command = text(params, "command")!;
    const label = text(params, "label", false);
    if (label && label.length > 80) throw new Error("label must be at most 80 characters");
    const cwd = commandCwd(text(params, "cwd", false));
    return {
        taskId: commandTaskId(command, cwd, label),
        project: request.project,
        source: "project",
        label: label ?? (command.length > 80 ? `${command.slice(0, 79)}…` : command),
        command,
        cwd: cwd ? joinPath(request.project, cwd) : request.project,
        env: {},
        cols: 120,
        rows: 30,
    };
}

function launchCommand(request: HarnessRequest, launch: HarnessLaunchRequest, key: string, replace = false): HarnessLaunch {
    const { project } = request;
    const previous = replace ? harnessTasks.latest(project, launch.taskId) : undefined;
    return harnessTasks.start(
        project,
        launch.taskId,
        key,
        async () => {
            projectSession(request);
            if (previous) await harnessTasks.stop(project, previous.executionId);
            return { request: launch };
        },
        { agentId: request.agentId ?? undefined, replace },
    );
}

function earlierCommand(project: string, taskId: string): HarnessLaunchRequest {
    const launch = harnessTasks.launchRequest(project, taskId);
    if (!launch) throw new Error(`Task ${taskId} has not been started from this app session; start it again with command`);
    return launch;
}

function launchTask(request: HarnessRequest, key: string): HarnessLaunch | Promise<HarnessLaunch> {
    const { params, project } = request;
    const taskId = text(params, "taskId", false);
    if (taskId && params.command !== undefined) throw new Error("Pass either taskId or command, not both");
    if (!taskId && params.command === undefined) throw new Error("taskId or command is required");
    if (!taskId) return launchCommand(request, commandLaunch(request, params), key);
    if (params.cwd !== undefined || params.label !== undefined) throw new Error("cwd and label go with command; a sikemux.json task sets its own");
    if (!taskId.startsWith(COMMAND_TASK_PREFIX)) return launchConfigured(request, taskId, key);
    return harnessTasks.existing(project, taskId, key) ?? launchCommand(request, earlierCommand(project, taskId), key);
}

/* MCP hosts give up on a tool call after about a minute, and the native bridge
   after 65 s, so a start answers well before either with whatever state it reached. */
const START_BUDGET_MS = 30_000;

async function nextEvent(project: string, cursor: string, until: number, executionId: string, done: Promise<unknown>, signal?: AbortSignal) {
    const local = new AbortController();
    const forward = () => local.abort(signal?.reason);
    signal?.addEventListener("abort", forward, { once: true });
    try {
        await Promise.race([done, harnessEvents.wait(project, cursor, Math.min(Math.max(until - Date.now(), 0), 30_000), executionId, local.signal)]);
    } finally {
        signal?.removeEventListener("abort", forward);
        local.abort();
    }
}

async function settle(project: string, launch: HarnessLaunch, until: number, signal?: AbortSignal): Promise<HarnessRun> {
    const outcome: { done: boolean; error?: unknown } = { done: false };
    const done = launch.started.then(
        () => {
            outcome.done = true;
        },
        (error: unknown) => {
            outcome.done = true;
            outcome.error = error ?? new Error("Task could not be started");
        },
    );
    for (;;) {
        if (signal?.aborted) throw signal.reason;
        const cursor = harnessEvents.cursor;
        if (outcome.done) {
            if (outcome.error) throw outcome.error;
            return harnessTasks.get(project, launch.executionId);
        }
        const run = harnessTasks.get(project, launch.executionId);
        if (run.status === "awaiting-trust" || Date.now() >= until) return run;
        await nextEvent(project, cursor, until, launch.executionId, done, signal);
    }
}

async function outputAppears(project: string, executionId: string, pattern: string, until: number, signal?: AbortSignal): Promise<boolean> {
    for (;;) {
        const cursor = harnessEvents.cursor;
        const run = harnessTasks.get(project, executionId);
        if (run.ptyId !== undefined) {
            const page = await readOutput(run.ptyId, { cursor: 0, limit: 4096, tail: 1, search: pattern, context: 0, plain: false });
            if (page.matches) return true;
        }
        if (!["starting", "running"].includes(run.status) || Date.now() >= until) return false;
        await nextEvent(project, cursor, until, executionId, new Promise(() => {}), signal);
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
}

const PENDING_NOTES: Partial<Record<HarnessRun["status"], string>> = {
    "awaiting-trust":
        "Waiting for the person to trust this project's sikemux.json in Sikemux. Call task_start again with the same idempotencyKey, or events_wait with this executionId, to see when it starts.",
    starting: "Still starting. Call task_start again with the same idempotencyKey, or events_wait with this executionId, to see when it runs.",
};

async function answerStart(project: string, launch: HarnessLaunch, until: number, readyWhen: string | undefined, signal?: AbortSignal) {
    const run = await settle(project, launch, until, signal);
    const note = PENDING_NOTES[run.status];
    if (note) return readyWhen ? { ...run, ready: false, note } : { ...run, note };
    if (!readyWhen) return run;
    const ready = await outputAppears(project, run.executionId, readyWhen, until, signal);
    const latest = harnessTasks.get(project, run.executionId);
    if (ready || latest.status !== "running") return { ...latest, ready };
    return {
        ...latest,
        ready,
        note: "The task is running but readyWhen has not appeared yet. Wait with events_wait on this executionId, or task_read with search.",
    };
}

export async function handleHarnessRequest(request: HarnessRequest, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw signal.reason;
    const session = projectSession(request);
    const { params, project } = request;
    switch (request.method) {
        case "workspace.inspect": {
            const state = useStore.getState();
            const config = await loadProjectConfig(project);
            return {
                project,
                sessionId: session.id,
                agentId: request.agentId,
                active: state.activeSessionId === session.id,
                activeWindowId: session.activeWindowId,
                windows: (state.windowsBySession[session.id] ?? [])
                    .map((id) => state.windows[id])
                    .filter(Boolean)
                    .map((window) => ({
                        id: window.id,
                        name: window.name,
                        role: window.role,
                        panes: collectPanes(window.root).map((pane) => ({
                            id: pane.id,
                            kind: pane.kind,
                            cwd: pane.cwd,
                            activePath: state.editorViews[pane.id]?.activePath,
                            openTabs: state.editorViews[pane.id]?.openTabs,
                        })),
                    })),
                tasks: config.status === "valid" ? config.config.tasks.map(({ id, label, command, cwd }) => ({ id, label, command, cwd })) : [],
                configStatus: config.status,
                configErrors: config.status === "invalid" ? config.errors : undefined,
                runs: harnessTasks.list(project),
                userTask: (() => {
                    const task = appTaskRuntime.getSnapshot(project);
                    return task ? { status: task.status, taskId: task.task?.id } : null;
                })(),
                cursor: harnessEvents.cursor,
            };
        }
        case "task.start": {
            const until = Date.now() + START_BUDGET_MS;
            const key = text(params, "idempotencyKey")!;
            if (key.length > 128) throw new Error("idempotencyKey must be at most 128 characters");
            const readyWhen = text(params, "readyWhen", false);
            return answerStart(project, await launchTask(request, key), until, readyWhen, signal);
        }
        case "task.restart": {
            const until = Date.now() + START_BUDGET_MS;
            const taskId = text(params, "taskId")!;
            const key = crypto.randomUUID();
            const launch = taskId.startsWith(COMMAND_TASK_PREFIX)
                ? launchCommand(request, earlierCommand(project, taskId), key, true)
                : await launchConfigured(request, taskId, key, true);
            return answerStart(project, launch, until, undefined, signal);
        }
        case "task.read": {
            const run = harnessTasks.get(project, executionFor(project, params));
            if (params.plain !== undefined && typeof params.plain !== "boolean") throw new Error("plain must be a boolean");
            const query: OutputQuery = {
                cursor: integer(params, "cursor", 0, Number.MAX_SAFE_INTEGER),
                limit: integer(params, "limit", 8192, 8192, 4),
                tail: params.tail === undefined ? undefined : integer(params, "tail", 1, 10_000, 1),
                search: text(params, "search", false),
                context: integer(params, "context", 3, 20),
                plain: params.plain === true,
            };
            if (run.ptyId === undefined) return { ...run, output: "", cursor: 0, end: 0, hasMore: false, truncated: false };
            const output = await readOutput(run.ptyId, query);
            return {
                ...run,
                output: new TextDecoder().decode(new Uint8Array(output.bytes)),
                cursor: output.cursor,
                end: output.end,
                hasMore: output.hasMore,
                truncated: output.truncated,
                matches: output.matches,
            };
        }
        case "task.stop":
            return harnessTasks.stop(project, executionFor(project, params));
        case "events.wait":
            return harnessEvents.wait(
                project,
                text(params, "cursor")!,
                integer(params, "timeoutMs", 30_000, 30_000),
                text(params, "executionId", false),
                signal,
            );
        case "ui.open": {
            const kind = text(params, "kind")!;
            if (params.focus !== undefined && typeof params.focus !== "boolean") throw new Error("focus must be a boolean");
            const focus = params.focus === true;
            if (kind === "preview") {
                if (!request.agentId) throw new Error("Opening a preview requires a Sikemux agent session");
                const config = await loadProjectConfig(project);
                const url = config.status === "valid" ? config.config.preview?.url : undefined;
                if (!url) throw new Error("No preview URL is configured in sikemux.json");
                const tabId = await browserApi.newTab(request.agentId, url);
                commands.showDeskBrowser(request.agentId);
                if (focus) {
                    commands.selectSession(session.id);
                    commands.selectAgent(request.agentId);
                }
                return { kind, tabId, url };
            }
            if (kind === "file" && request.agentId) {
                const agentId = request.agentId;
                const path = await invokeCommand<string>("harness_resolve_path", { project, path: text(params, "path")! });
                const line = integer(params, "line", 1, 10_000_000, 1) - 1;
                commands.openFileOnDesk(agentId, path, line, 0, { focus: false });
                if (focus) {
                    commands.selectSession(session.id);
                    commands.selectAgent(agentId);
                }
                harnessEvents.publish({ project, kind: "ui.opened" });
                return { kind, agentId, path };
            }
            const onDesk = kind === "terminal" ? commands.deskTerminalFor(harnessTasks.get(project, text(params, "executionId")!).executionId) : null;
            if (onDesk) {
                commands.showDeskTerminal(onDesk.agentId, onDesk.id);
                if (focus) {
                    commands.selectSession(session.id);
                    commands.selectAgent(onDesk.agentId);
                }
                harnessEvents.publish({ project, kind: "ui.opened" });
                return { kind, agentId: onDesk.agentId };
            }
            const path = kind === "file" ? await invokeCommand<string>("harness_resolve_path", { project, path: text(params, "path")! }) : undefined;
            const line = integer(params, "line", 1, 10_000_000, 1) - 1;
            const open = () => {
                commands.selectSession(session.id);
                if (kind === "file" && !focus) {
                    commands.openEditorPane();
                    const state = useStore.getState();
                    const window = state.windows[state.sessions[session.id].activeWindowId];
                    const pane = collectPanes(window.root).find((pane) => pane.kind === "editor");
                    if (!pane) throw new Error("Project has no editor pane");
                    commands.openEditorTab(pane.id, path!, false);
                } else if (kind === "file") {
                    const failures = commands.routeCliOpenRequest({
                        id: request.id,
                        cwd: project,
                        wait: false,
                        targets: [{ id: request.id, kind: "file", path: path!, projectRoot: project, line }],
                    });
                    if (failures.some((result) => result.error)) throw new Error(failures.find((result) => result.error)!.error!);
                } else if (kind === "diff") commands.openDiffPane();
                else if (kind === "terminal") {
                    const run = harnessTasks.get(project, text(params, "executionId")!);
                    const window = (useStore.getState().windowsBySession[session.id] ?? [])
                        .map((id) => useStore.getState().windows[id])
                        .find((window) =>
                            collectPanes(window.root).some((pane) => taskPtyBindings.getSnapshot(pane.id)?.executionId === run.executionId),
                        );
                    if (!window) throw new Error("Task terminal is no longer open");
                    commands.selectWindowId(window.id);
                } else throw new Error("kind must be file, diff, terminal, or preview");
                return { kind, windowId: useStore.getState().sessions[session.id].activeWindowId, path };
            };
            const result = focus ? open() : preserveFocus(open);
            harnessEvents.publish({ project, kind: "ui.opened" });
            return result;
        }
        default:
            throw new Error("Unknown harness method");
    }
}

import { useEffect, useRef, type RefObject } from "react";
import { Channel } from "@tauri-apps/api/core";
import { invokeCommand as invoke } from "../api/invoke";
import { registerPtyDrop } from "../state/dropRegistry";
import { IS_WINDOWS } from "../lib/platform";
import type { PtyContext } from "../state/types";
import { createItemId } from "../workbench/registry";
import { getOrCreateWorkbenchItemResource } from "../workbench/itemRuntime";
import { PtyLifecycleController, type PtyApi, type PtyAttachResult, type PtyChannelAdapter, type PtyControllerErrorEvent } from "./ptyController";
import { performanceTelemetry } from "../lib/performance";

type NativeChannel = Channel<number[]>;
export type NativePtyController = PtyLifecycleController<NativeChannel, PtyContext>;
export type TerminalShellSemantics = "posix" | "powershell";

const NATIVE_PTY_RESOURCE = "core.terminal.pty";
const DEFAULT_SHELL_SEMANTICS: TerminalShellSemantics = IS_WINDOWS ? "powershell" : "posix";

interface IntegrationHealthShell {
    readonly shell?: unknown;
}

const nativePtyApi: PtyApi<NativeChannel, PtyContext> = {
    spawn: (request) => invoke<number>("pty_spawn", { ...request }),
    write: (id, data) => invoke<void>("pty_write", { id, data }),
    resize: (id, cols, rows) => invoke<void>("pty_resize", { id, cols, rows }),
    kill: (id) => invoke<void>("pty_kill", { id }),
    attach: (id, channel) => invoke<PtyAttachResult>("pty_attach", { id, onEvent: channel }),
    detach: (id, subId) => invoke<void>("pty_unsubscribe", { id, subId }),
};

const nativeChannels: PtyChannelAdapter<NativeChannel> = {
    create: (onMessage) => {
        const channel = new Channel<number[]>();
        channel.onmessage = onMessage;
        return {
            transport: channel,
            close: () => {
                channel.onmessage = () => {};
            },
        };
    },
};

function requireLiteralPath(path: string): void {
    if (path.includes("\0")) throw new TypeError("terminal drop paths cannot contain NUL bytes");
}

/** Encode one path as a single POSIX shell word without evaluating any of it. */
export function encodePosixShellLiteral(path: string): string {
    requireLiteralPath(path);
    return `'${path.replaceAll("'", "'\\''")}'`;
}

/** Encode one path as a PowerShell single-quoted string literal. */
export function encodePowerShellLiteral(path: string): string {
    requireLiteralPath(path);
    return `'${path.replaceAll("'", "''")}'`;
}

/** Determine quoting rules from the configured executable, independent of host OS. */
export function shellSemanticsForExecutable(shell: string): TerminalShellSemantics | null {
    const trimmed = shell.trim();
    const unquoted =
        trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))
            ? trimmed.slice(1, -1)
            : trimmed;
    const executable =
        unquoted
            .split(/[\\/]/)
            .at(-1)
            ?.toLowerCase()
            .replace(/\.exe$/, "") ?? "";
    if (executable === "powershell" || executable === "pwsh") return "powershell";
    if (["sh", "bash", "zsh", "dash", "ash", "ksh", "mksh", "fish"].includes(executable)) return "posix";
    return null;
}

async function configuredShellSemantics(): Promise<TerminalShellSemantics> {
    try {
        const health = await invoke<IntegrationHealthShell>("integration_health");
        if (health && typeof health.shell === "string") {
            return shellSemanticsForExecutable(health.shell) ?? DEFAULT_SHELL_SEMANTICS;
        }
    } catch {
        // invokeCommand already records the failed IPC. Keep drag/drop usable
        // with the same default the native PTY launcher uses on this platform.
    }
    return DEFAULT_SHELL_SEMANTICS;
}

function encodeDroppedPaths(paths: readonly string[], semantics: TerminalShellSemantics): string {
    const encode = semantics === "powershell" ? encodePowerShellLiteral : encodePosixShellLiteral;
    return paths.map(encode).join(" ");
}

function recordControllerError(event: PtyControllerErrorEvent): void {
    performanceTelemetry.incrementCounter(`terminal.controller.errors.${event.operation}`);
}

export function usePty(opts: {
    cwd?: string;
    startup?: string;
    initialInput?: string;
    onInitialInputDelivered?: () => void;
    hostRef: RefObject<HTMLDivElement | null>;
    spawnWhen?: boolean;
    context?: PtyContext;
    /** Durable workbench item owner. Omit for popups, agents, and embedded shells. */
    durableItemId?: string;
}): RefObject<NativePtyController | null> {
    const { hostRef, spawnWhen = true } = opts;
    const controllerRef = useRef<NativePtyController | null>(null);
    const deliveredRef = useRef(opts.onInitialInputDelivered);
    deliveredRef.current = opts.onInitialInputDelivered;
    const initialOptionsRef = useRef(opts);

    useEffect(() => {
        const initial = initialOptionsRef.current;
        const createController = () =>
            new PtyLifecycleController<NativeChannel, PtyContext>({
                api: nativePtyApi,
                channels: nativeChannels,
                cwd: initial.cwd,
                startup: initial.startup,
                context: initial.context,
                initialInput: initial.initialInput,
                onInitialInputDelivered: () => deliveredRef.current?.(),
                onError: recordControllerError,
            });
        const durableItemId = initial.durableItemId;
        const durable = !!durableItemId;
        const controller = durableItemId
            ? getOrCreateWorkbenchItemResource(createItemId(durableItemId), NATIVE_PTY_RESOURCE, () => {
                  const value = createController();
                  return { value, dispose: () => value.dispose() };
              })
            : createController();
        controllerRef.current = controller;

        const host = hostRef.current;
        let active = true;
        let shellSemanticsPromise: Promise<TerminalShellSemantics> | null = null;
        const resolveShellSemantics = () => (shellSemanticsPromise ??= configuredShellSemantics());
        const unregisterDrop = host
            ? registerPtyDrop(host, (paths) => {
                  if (paths.length === 0) return;
                  const droppedPaths = [...paths];
                  if (droppedPaths.some((path) => path.includes("\0"))) {
                      performanceTelemetry.incrementCounter("terminal.drop.rejected.nul");
                      return;
                  }
                  void resolveShellSemantics()
                      .then((semantics) => {
                          if (!active) return;
                          const body = encodeDroppedPaths(droppedPaths, semantics);
                          return controller.write(`\x1b[200~${body}\x1b[201~`);
                      })
                      // PtyLifecycleController is the sole reporter for write
                      // failures; this catch only prevents an unhandled promise.
                      .catch(() => {});
              })
            : () => {};

        return () => {
            active = false;
            unregisterDrop();
            if (controllerRef.current === controller) controllerRef.current = null;
            if (!durable) void controller.dispose();
        };
    }, [hostRef]);

    useEffect(() => {
        if (!spawnWhen) return;
        const controller = controllerRef.current;
        if (controller) void controller.start().catch(() => {});
    }, [spawnWhen]);

    return controllerRef;
}

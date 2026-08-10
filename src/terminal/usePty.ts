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

const NATIVE_PTY_RESOURCE = "core.terminal.pty";

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

function shellPathArgument(path: string): string {
    return IS_WINDOWS ? `'${path.replaceAll("'", "''")}'` : path.replace(/([\s'"\\])/g, "\\$1");
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
        const unregisterDrop = host
            ? registerPtyDrop(host, (paths) => {
                  if (paths.length === 0) return;
                  const body = paths.map(shellPathArgument).join(" ");
                  void controller.write(`\x1b[200~${body}\x1b[201~`).catch((error) => recordControllerError({ operation: "write", error }));
              })
            : () => {};

        return () => {
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

import { useEffect, useRef, type RefObject } from "react";
import { invokeCommand as invoke } from "../api/invoke";
import { registerPtyDrop } from "../state/dropRegistry";
import { IS_WINDOWS } from "../lib/platform";
import type { PtyContext } from "../state/types";

function shellPathArgument(path: string): string {
    return IS_WINDOWS ? `'${path.replaceAll("'", "''")}'` : path.replace(/([\s'"\\])/g, "\\$1");
}

export function usePty(opts: {
    cwd?: string;
    startup?: string;
    initialInput?: string;
    onInitialInputDelivered?: () => void;
    hostRef: RefObject<HTMLDivElement | null>;
    spawnWhen?: boolean;
    context?: PtyContext;
}): RefObject<Promise<number> | null> {
    const { cwd, startup, initialInput, onInitialInputDelivered, hostRef, spawnWhen = true, context } = opts;
    const readyRef = useRef<Promise<number> | null>(null);
    const pidRef = useRef<number | null>(null);
    const spawnedRef = useRef(false);
    const disposedRef = useRef(false);
    const unregisterDropRef = useRef<(() => void) | null>(null);
    const initialInputTimerRef = useRef<number | null>(null);

    useEffect(() => {
        const host = hostRef.current;
        if (host) {
            unregisterDropRef.current = registerPtyDrop(host, (paths) => {
                const pid = pidRef.current;
                if (pid === null || paths.length === 0) return;
                const body = paths.map(shellPathArgument).join(" ");
                void invoke("pty_write", {
                    id: pid,
                    data: `\x1b[200~${body}\x1b[201~`,
                });
            });
        }

        return () => {
            disposedRef.current = true;
            const id = pidRef.current;
            pidRef.current = null;
            unregisterDropRef.current?.();
            unregisterDropRef.current = null;
            if (initialInputTimerRef.current !== null) window.clearTimeout(initialInputTimerRef.current);
            if (id !== null) void invoke("pty_kill", { id });
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        if (!spawnWhen || spawnedRef.current || disposedRef.current) return;
        spawnedRef.current = true;

        let resolveReady: (id: number) => void = () => {};
        let rejectReady: (e: unknown) => void = () => {};
        readyRef.current = new Promise<number>((resolve, reject) => {
            resolveReady = resolve;
            rejectReady = reject;
        });

        invoke<number>("pty_spawn", {
            cols: 80,
            rows: 24,
            cwd: cwd ?? null,
            startup: startup ?? null,
            context: context ?? null,
        }).then(
            (id) => {
                if (disposedRef.current) {
                    void invoke("pty_kill", { id });
                    return;
                }
                pidRef.current = id;
                resolveReady(id);
                if (initialInput?.trim()) {
                    initialInputTimerRef.current = window.setTimeout(() => {
                        initialInputTimerRef.current = null;
                        if (disposedRef.current || pidRef.current !== id) return;
                        void invoke("pty_write", {
                            id,
                            data: `\x1b[200~${initialInput.trim()}\x1b[201~\r`,
                        })
                            .then(() => onInitialInputDelivered?.())
                            .catch(() => {
                                // Keep the runtime input on failure so a later
                                // terminal remount can safely retry delivery.
                            });
                    }, 800);
                }
            },
            (err) => {
                spawnedRef.current = false;
                readyRef.current = null;
                rejectReady(err);
            },
        );
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [spawnWhen]);

    return readyRef;
}

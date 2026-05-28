import { useEffect, useRef, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { registerPtyDrop } from "../state/dropRegistry";

/** Lazy lifecycle around a single Tauri PTY.
 *
 *  Spawns the first time `spawnWhen` becomes true, kills on unmount.
 *  `cwd` and `startup` are captured at spawn time — later changes have
 *  no effect. `startup` (when set)
 *  is written by the backend on the first byte of shell output, so
 *  the frontend never needs a delay timer.
 *
 *  Also installs a drag-drop handler on `hostRef` via the typed
 *  registry: paths dropped over the terminal element are wrapped in
 *  bracketed-paste markers (`\x1b[200~ … \x1b[201~`) so the running
 *  TUI (claude / codex / hermes) treats them as a single paste — that
 *  is how their @-file / image-attachment sniffers fire.
 *
 *  The returned ref carries a Promise that resolves to the PTY id once
 *  the spawn IPC completes (or rejects on failure). It's null between
 *  the hook's first render and its mount effect — but `useXterm` (or
 *  any consumer that awaits it inside its own effect) is guaranteed to
 *  see it set, because effects fire in declaration order. */
export function usePty(opts: {
  cwd?: string;
  startup?: string;
  hostRef: RefObject<HTMLDivElement | null>;
  spawnWhen?: boolean;
}): RefObject<Promise<number> | null> {
  const { cwd, startup, hostRef, spawnWhen = true } = opts;
  const readyRef = useRef<Promise<number> | null>(null);
  const pidRef = useRef<number | null>(null);
  const spawnedRef = useRef(false);
  const disposedRef = useRef(false);
  const unregisterDropRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (host) {
      unregisterDropRef.current = registerPtyDrop(host, (paths) => {
        const pid = pidRef.current;
        if (pid === null || paths.length === 0) return;
        const body = paths
          .map((p) => p.replace(/([\s'"\\])/g, "\\$1"))
          .join(" ");
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
      if (id !== null) void invoke("pty_kill", { id });
    };
    // cwd/startup are captured at spawn — re-running this effect would
    // mean killing the live shell and spinning a new one, which is never
    // what the caller wants.
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
    }).then(
      (id) => {
        if (disposedRef.current) {
          // User unmounted between IPC send and reply — kill the orphan
          // shell rather than leaking it; consumers won't see this id.
          void invoke("pty_kill", { id });
          return;
        }
        pidRef.current = id;
        resolveReady(id);
      },
      (err) => {
        spawnedRef.current = false;
        readyRef.current = null;
        rejectReady(err);
      },
    );
    // cwd/startup are captured at first spawn. Later prop changes should not
    // kill or restart a live shell.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spawnWhen]);

  return readyRef;
}

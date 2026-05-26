import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Channel, invoke } from "@tauri-apps/api/core";
import "@xterm/xterm/css/xterm.css";
import { currentTheme, registerTerminal } from "../themes/bus";
import { registerPtyDrop } from "../state/dropRegistry";

const FONT = '"JetBrainsMono Nerd Font", monospace';
// Must match `PARSER_SCROLLBACK` in src-tauri/src/pty.rs so a fresh xterm
// can repaint the full grid+scrollback returned by `pty_attach`.
const SCROLLBACK = 10_000;

// macOS chord → readline escape, written straight to the PTY. Cmd-arrows
// and friends never reach xterm's normal `onData` pipeline (macOS swallows
// them), so we intercept via attachCustomKeyEventHandler.
const META_CHORDS: Record<string, string> = {
  "Meta+ArrowLeft": "\x01", // Ctrl-A: start of line
  "Meta+ArrowRight": "\x05", // Ctrl-E: end of line
  "Meta+Backspace": "\x15", // Ctrl-U: kill to start of line
};
const ALT_CHORDS: Record<string, string> = {
  "Alt+ArrowLeft": "\x1bb", // Esc-b: back one word
  "Alt+ArrowRight": "\x1bf", // Esc-f: forward one word
  "Alt+Backspace": "\x1b\x7f", // Esc-DEL: delete previous word
};

interface AttachResult {
  subId: number;
  snapshot: number[];
}

// ARCH: PTY screen state lives in a Rust-side `vt100::Parser`. This pane
// owns the PTY for its full lifetime but the xterm + WebGL context is
// only mounted while `active` is true. On show:
//   1. spawn xterm
//   2. `pty_attach` returns { subId, snapshot } in a single IPC — atomic
//      against the reader thread so we never duplicate/drop bytes
//   3. write the snapshot once → screen state restored without replaying
//      N seconds of history
//   4. subsequent live bytes arrive on the Channel
// On hide:
//   * unsubscribe and dispose the xterm — frees the WebGL context. The
//     Rust parser keeps tracking output; the next show gets a fresh
//     snapshot. Lets us run 100s of hidden agents inside WebKit's
//     ~8-16 concurrent WebGL-context cap.
export function TerminalPane({
  cwd,
  startup,
  active,
}: {
  cwd?: string;
  startup?: string;
  active: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const ptyIdRef = useRef<number | null>(null);
  // Resolves once the PTY id is known. The active-effect awaits this so a
  // user that immediately switches to this pane on creation doesn't race
  // against pty_spawn.
  const ptyReadyRef = useRef<Promise<number> | null>(null);

  // ---- PTY lifecycle (mount once, kill on unmount) ----
  useEffect(() => {
    const host = hostRef.current!;
    let disposed = false;
    let resolveReady: (id: number) => void = () => {};
    let rejectReady: (e: unknown) => void = () => {};
    ptyReadyRef.current = new Promise<number>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    invoke<number>("pty_spawn", {
      cols: 80,
      rows: 24,
      cwd: cwd ?? null,
    }).then(
      (id) => {
        if (disposed) {
          void invoke("pty_kill", { id });
          return;
        }
        ptyIdRef.current = id;
        resolveReady(id);
        if (startup) {
          window.setTimeout(() => {
            if (!disposed && ptyIdRef.current !== null) {
              void invoke("pty_write", {
                id: ptyIdRef.current,
                data: `${startup}\r`,
              });
            }
          }, 350);
        }
      },
      (err) => {
        rejectReady(err);
      },
    );

    // Drag-drop hook — App.tsx's single drop subscription dispatches via
    // dropRegistry to this terminal's registered handler. We wrap the
    // dropped paths in bracketed paste markers (\x1b[200~ … \x1b[201~)
    // so the active app sees them as a single paste, not character-by-
    // character typing. That's what lets Claude Code / Codex / hermes run
    // their paste→image sniffers — drop a .png and it attaches as
    // `[Image #N]` instead of leaving the literal path in the input line.
    // Shells in bracketed-paste mode (default in zsh/bash with readline)
    // treat the chunk as one editable token, so backslash-escaping spaces
    // + quotes is enough for them to round-trip a path through.
    const unregisterDrop = registerPtyDrop(host, (paths) => {
      const pid = ptyIdRef.current;
      if (pid === null || paths.length === 0) return;
      const body = paths
        .map((p) => p.replace(/([\s'"\\])/g, "\\$1"))
        .join(" ");
      void invoke("pty_write", {
        id: pid,
        data: `\x1b[200~${body}\x1b[201~`,
      });
    });

    return () => {
      disposed = true;
      const id = ptyIdRef.current;
      ptyIdRef.current = null;
      unregisterDrop();
      if (id !== null) void invoke("pty_kill", { id });
    };
    // Mount once: cwd/startup are captured at spawn and never change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- xterm lifecycle (only while active) ----
  useEffect(() => {
    if (!active) return;
    const host = hostRef.current!;
    let disposed = false;
    let cleanup = () => {};

    const boot = async () => {
      if (disposed) return;
      const pid = await ptyReadyRef.current!.catch(() => null);
      if (disposed || pid === null) return;

      const term = new Terminal({
        fontFamily: FONT,
        fontSize: 13,
        lineHeight: 1.2,
        theme: currentTheme().terminal,
        cursorBlink: true,
        allowProposedApi: true,
        allowTransparency: true,
        macOptionIsMeta: true,
        scrollback: SCROLLBACK,
      });
      const unregisterTheme = registerTerminal(term);
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(host);
      try {
        term.loadAddon(new WebglAddon());
      } catch {
        // WebGL unavailable — Xterm falls back to its canvas renderer.
      }
      fit.fit();

      // Sync parser geometry to actual xterm dimensions BEFORE snapshot so
      // the returned grid matches our cols/rows. Otherwise reattach lands
      // on a mis-sized canvas and the first paint looks rewrapped.
      await invoke("pty_resize", {
        id: pid,
        cols: term.cols,
        rows: term.rows,
      });

      // Buffer any live chunks that arrive while pty_attach is in flight
      // / before we've written the snapshot. They'll all be NEW bytes
      // (the parser lock ensures no overlap with the snapshot), so we
      // play them back in order right after the snapshot writes.
      let snapshotApplied = false;
      const pending: number[][] = [];
      const channel = new Channel<number[]>();
      const writeChunk = (chunk: number[]) => {
        if (chunk.length === 0) {
          term.write("\r\n\x1b[38;5;245m[process exited]\x1b[0m\r\n");
        } else {
          term.write(new Uint8Array(chunk));
        }
      };
      channel.onmessage = (chunk) => {
        if (!snapshotApplied) {
          pending.push(chunk);
          return;
        }
        writeChunk(chunk);
      };

      const { subId, snapshot } = await invoke<AttachResult>("pty_attach", {
        id: pid,
        onEvent: channel,
      });
      if (disposed) {
        void invoke("pty_unsubscribe", { id: pid, subId });
        unregisterTheme();
        term.dispose();
        return;
      }
      if (snapshot.length > 0) term.write(new Uint8Array(snapshot));
      snapshotApplied = true;
      for (const chunk of pending) writeChunk(chunk);
      pending.length = 0;

      // ---- input batching ----
      // Coalesce onData chunks within one microtask into a single pty_write
      // IPC. Paste-heavy or fast-typing flows used to make 100s of IPC
      // round-trips per second; now it's one per frame.
      let pendingInput = "";
      let scheduled = false;
      const flushInput = () => {
        scheduled = false;
        if (!pendingInput) return;
        const data = pendingInput;
        pendingInput = "";
        void invoke("pty_write", { id: pid, data });
      };
      const dataSub = term.onData((data) => {
        pendingInput += data;
        if (!scheduled) {
          scheduled = true;
          queueMicrotask(flushInput);
        }
      });

      // ---- key chord interception ----
      // macOS Cmd-arrows / Cmd-backspace and Opt-arrows / Opt-backspace
      // never make it through xterm's default routing, so we synthesise
      // the readline-equivalent escape directly. Returning false stops
      // xterm from also processing the event (which would beep / insert).
      term.attachCustomKeyEventHandler((e) => {
        if (e.type !== "keydown") return true;
        const keyParts: string[] = [];
        if (e.metaKey) keyParts.push("Meta");
        if (
          e.altKey &&
          (e.key === "ArrowLeft" ||
            e.key === "ArrowRight" ||
            e.key === "Backspace")
        ) {
          keyParts.push("Alt");
        }
        if (keyParts.length === 0) return true;
        const sig = `${keyParts.join("+")}+${e.key}`;
        const seq = META_CHORDS[sig] ?? ALT_CHORDS[sig];
        if (seq === undefined) return true;
        void invoke("pty_write", { id: pid, data: seq });
        e.preventDefault();
        e.stopPropagation();
        return false;
      });

      const resize = () => {
        if (host.clientWidth === 0 || host.clientHeight === 0) return;
        fit.fit();
        void invoke("pty_resize", {
          id: pid,
          cols: term.cols,
          rows: term.rows,
        });
      };
      const ro = new ResizeObserver(resize);
      ro.observe(host);

      term.focus();

      cleanup = () => {
        unregisterTheme();
        ro.disconnect();
        dataSub.dispose();
        void invoke("pty_unsubscribe", { id: pid, subId });
        term.dispose();
      };
    };

    Promise.all([
      document.fonts.load('13px "JetBrainsMono Nerd Font"'),
      document.fonts.load('italic 13px "JetBrainsMono Nerd Font"'),
      document.fonts.load('bold 13px "JetBrainsMono Nerd Font"'),
    ]).then(boot, boot);

    return () => {
      disposed = true;
      cleanup();
    };
  }, [active]);

  return <div ref={hostRef} className="terminal-host" />;
}

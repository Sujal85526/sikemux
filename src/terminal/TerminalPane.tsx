import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Channel, invoke } from "@tauri-apps/api/core";
import "@xterm/xterm/css/xterm.css";
import { currentTheme, registerTerminal } from "../themes/bus";

const FONT = '"JetBrainsMono Nerd Font", monospace';

// Cap on per-terminal pending-output backlog when the pane is hidden. Agents
// like Claude Code can spew megabytes; we keep the most-recent slice so
// reactivation paints a useful tail without OOMing the renderer.
const HIDDEN_BACKLOG_BYTES = 512 * 1024;

// macOS chord → readline escape, written straight to the PTY. Cmd-arrows
// and friends never reach xterm's normal `onData` pipeline (macOS swallows
// them), so we intercept via attachCustomKeyEventHandler.
const META_CHORDS: Record<string, string> = {
  // ⌘ + Left/Right/Backspace — line-edit
  "Meta+ArrowLeft": "\x01", // Ctrl-A: start of line
  "Meta+ArrowRight": "\x05", // Ctrl-E: end of line
  "Meta+Backspace": "\x15", // Ctrl-U: kill to start of line
};
const ALT_CHORDS: Record<string, string> = {
  // ⌥ + Left/Right/Backspace — word-edit (zsh/bash emacs bindings)
  "Alt+ArrowLeft": "\x1bb", // Esc-b: back one word
  "Alt+ArrowRight": "\x1bf", // Esc-f: forward one word
  "Alt+Backspace": "\x1b\x7f", // Esc-DEL: delete previous word
};

// PERF: the terminal is mounted imperatively and lives outside React's render
// tree. PTY bytes arrive over a Channel (never the JSON event bus) and the
// WebGL addon paints the grid on the GPU. Xterm boot is gated on the bundled
// Nerd Font being loaded, so glyph metrics are measured correctly.
//
// While the pane is invisible we buffer PTY chunks in JS instead of calling
// term.write() — stops GPU paint work for background terminals (the previous
// behaviour kept every terminal across every session repainting forever,
// which is why multi-project layouts lagged).
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
  const termRef = useRef<Terminal | null>(null);
  // Live refs so the effect captures the latest values without re-mounting.
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    const host = hostRef.current!;
    let disposed = false;
    let cleanup = () => {};

    const boot = () => {
      if (disposed) return;
      const term = new Terminal({
        fontFamily: FONT,
        fontSize: 13,
        lineHeight: 1.2,
        theme: currentTheme().terminal,
        cursorBlink: true,
        allowProposedApi: true,
        allowTransparency: true,
        macOptionIsMeta: true,
        scrollback: 10000,
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
      termRef.current = term;

      let ptyId: number | null = null;

      // ---- output buffering: skip xterm.write while hidden ----
      // Backlog is a ring-buffer; cap at HIDDEN_BACKLOG_BYTES so a chatty
      // agent in a hidden tab doesn't grow this without bound.
      let backlog: Uint8Array[] = [];
      let backlogBytes = 0;
      let backlogTruncated = false;

      const flushBacklog = () => {
        if (backlog.length === 0) return;
        if (backlogTruncated) {
          term.write(
            "\r\n\x1b[38;5;245m[…earlier output trimmed while pane was hidden]\x1b[0m\r\n",
          );
        }
        for (const chunk of backlog) term.write(chunk);
        backlog = [];
        backlogBytes = 0;
        backlogTruncated = false;
      };

      const writeToTerm = (chunk: Uint8Array) => {
        if (activeRef.current) {
          term.write(chunk);
          return;
        }
        backlog.push(chunk);
        backlogBytes += chunk.byteLength;
        while (backlogBytes > HIDDEN_BACKLOG_BYTES && backlog.length > 1) {
          const dropped = backlog.shift()!;
          backlogBytes -= dropped.byteLength;
          backlogTruncated = true;
        }
      };

      // PTY output stream. Rust sends raw bytes; an empty chunk signals exit.
      const output = new Channel<number[]>();
      output.onmessage = (chunk) => {
        if (chunk.length === 0) {
          writeToTerm(
            new TextEncoder().encode(
              "\r\n\x1b[38;5;245m[process exited]\x1b[0m\r\n",
            ),
          );
          return;
        }
        writeToTerm(new Uint8Array(chunk));
      };

      invoke<number>("pty_spawn", {
        cols: term.cols,
        rows: term.rows,
        cwd: cwd ?? null,
        onEvent: output,
      }).then((id) => {
        if (disposed) {
          void invoke("pty_kill", { id });
          return;
        }
        ptyId = id;
        if (startup) {
          window.setTimeout(() => {
            if (!disposed && ptyId !== null) {
              void invoke("pty_write", { id: ptyId, data: `${startup}\r` });
            }
          }, 350);
        }
      });

      // ---- input batching ----
      // Coalesce onData chunks within one microtask into a single pty_write
      // IPC. Paste-heavy or fast-typing flows used to make 100s of IPC
      // round-trips per second; now it's one per frame.
      let pendingInput = "";
      let scheduled = false;
      const flushInput = () => {
        scheduled = false;
        if (!pendingInput || ptyId === null) return;
        const data = pendingInput;
        pendingInput = "";
        void invoke("pty_write", { id: ptyId, data });
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
      // never make it through xterm's default routing, so we synthesise the
      // readline-equivalent escape directly. Returning false stops xterm
      // from also processing the event (which would beep or insert chars).
      term.attachCustomKeyEventHandler((e) => {
        if (e.type !== "keydown") return true;
        const keyParts: string[] = [];
        if (e.metaKey) keyParts.push("Meta");
        // macOptionIsMeta: true turns Alt-letter into an ESC-prefixed code
        // through xterm's normal pipeline. We only short-circuit the
        // arrow/backspace variants which need explicit handling.
        if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Backspace")) {
          keyParts.push("Alt");
        }
        if (keyParts.length === 0) return true;
        const sig = `${keyParts.join("+")}+${e.key}`;
        const seq = META_CHORDS[sig] ?? ALT_CHORDS[sig];
        if (seq === undefined) return true;
        if (ptyId !== null) void invoke("pty_write", { id: ptyId, data: seq });
        e.preventDefault();
        e.stopPropagation();
        return false;
      });

      // ---- drag-drop hook ----
      // App.tsx's single drop subscription calls this back when a file is
      // dropped over this terminal's host element. We quote each path and
      // write a space-separated list to the PTY — same behaviour as Ghostty
      // / Terminal.app, which is what Claude Code / Codex sessions expect
      // for @-file and image ingestion.
      interface DropTarget {
        __sikemuxDropPaths?: (paths: string[]) => void;
      }
      (host as unknown as DropTarget).__sikemuxDropPaths = (paths) => {
        if (ptyId === null || paths.length === 0) return;
        // Single-quote each path with internal single quotes escaped, then
        // join with spaces. Trailing space so the user can keep typing.
        const text =
          paths
            .map((p) => `'${p.replace(/'/g, "'\\''")}'`)
            .join(" ") + " ";
        void invoke("pty_write", { id: ptyId, data: text });
      };

      const resize = () => {
        if (host.clientWidth === 0 || host.clientHeight === 0) return;
        fit.fit();
        if (ptyId !== null) {
          void invoke("pty_resize", { id: ptyId, cols: term.cols, rows: term.rows });
        }
      };
      const ro = new ResizeObserver(resize);
      ro.observe(host);

      if (activeRef.current) term.focus();

      cleanup = () => {
        unregisterTheme();
        ro.disconnect();
        dataSub.dispose();
        delete (host as unknown as DropTarget).__sikemuxDropPaths;
        if (ptyId !== null) void invoke("pty_kill", { id: ptyId });
        term.dispose();
        termRef.current = null;
      };

      // Expose flush so the visibility effect below can drain on reshow.
      (term as unknown as { __flushBacklog?: () => void }).__flushBacklog =
        flushBacklog;
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
    // Mount once: cwd/startup are captured at spawn and never change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // On show: flush the buffered chunks, then focus. On hide: nothing —
  // future PTY chunks naturally fall through writeToTerm's `activeRef`
  // gate without painting.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    if (active) {
      const flush = (term as unknown as { __flushBacklog?: () => void })
        .__flushBacklog;
      flush?.();
      term.focus();
    }
  }, [active]);

  return <div ref={hostRef} className="terminal-host" />;
}

import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Channel, invoke } from "@tauri-apps/api/core";
import "@xterm/xterm/css/xterm.css";
import { auraXterm } from "../theme";

// PERF: the terminal is mounted imperatively and lives entirely outside
// React's render tree. React never re-renders this subtree — only chrome.
// PTY bytes arrive over a Channel (Rust never goes through the JSON event
// bus) and the WebGL addon paints the grid on the GPU.
export function TerminalPane({ cwd }: { cwd?: string }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current!;
    const term = new Terminal({
      fontFamily: '"JetBrainsMono Nerd Font", "JetBrains Mono", monospace',
      fontSize: 13,
      lineHeight: 1.2,
      theme: auraXterm,
      cursorBlink: true,
      allowProposedApi: true,
      macOptionIsMeta: true,
      scrollback: 10000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    try {
      term.loadAddon(new WebglAddon());
    } catch {
      // WebGL unavailable — Xterm falls back to its canvas renderer.
    }
    fit.fit();

    let ptyId: number | null = null;
    let disposed = false;

    // PTY output stream. Rust sends raw bytes; an empty chunk signals exit.
    const output = new Channel<number[]>();
    output.onmessage = (chunk) => {
      if (chunk.length === 0) {
        term.write("\r\n\x1b[38;5;245m[process exited]\x1b[0m\r\n");
        return;
      }
      term.write(new Uint8Array(chunk));
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
    });

    const dataSub = term.onData((data) => {
      if (ptyId !== null) void invoke("pty_write", { id: ptyId, data });
    });

    const resize = () => {
      fit.fit();
      if (ptyId !== null) {
        void invoke("pty_resize", { id: ptyId, cols: term.cols, rows: term.rows });
      }
    };
    const ro = new ResizeObserver(resize);
    ro.observe(host);

    term.focus();

    return () => {
      disposed = true;
      ro.disconnect();
      dataSub.dispose();
      if (ptyId !== null) void invoke("pty_kill", { id: ptyId });
      term.dispose();
    };
  }, [cwd]);

  return <div ref={hostRef} className="terminal-pane" />;
}

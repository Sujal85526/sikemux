import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Channel, invoke } from "@tauri-apps/api/core";
import "@xterm/xterm/css/xterm.css";
import { auraXterm } from "../theme";

// PERF: the terminal is mounted imperatively and lives outside React's render
// tree. React never re-renders this subtree. PTY bytes arrive over a Channel
// (never the JSON event bus) and the WebGL addon paints the grid on the GPU.
// The component mounts once per pane id and is repositioned, never remounted.
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
    termRef.current = term;

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
      // Run the pane's startup command once the shell has settled.
      if (startup) {
        window.setTimeout(() => {
          if (!disposed && ptyId !== null) {
            void invoke("pty_write", { id: ptyId, data: `${startup}\r` });
          }
        }, 350);
      }
    });

    const dataSub = term.onData((data) => {
      if (ptyId !== null) void invoke("pty_write", { id: ptyId, data });
    });

    // The pane is repositioned on every split/resize; refit + tell the PTY.
    const resize = () => {
      if (host.clientWidth === 0 || host.clientHeight === 0) return;
      fit.fit();
      if (ptyId !== null) {
        void invoke("pty_resize", { id: ptyId, cols: term.cols, rows: term.rows });
      }
    };
    const ro = new ResizeObserver(resize);
    ro.observe(host);

    return () => {
      disposed = true;
      ro.disconnect();
      dataSub.dispose();
      if (ptyId !== null) void invoke("pty_kill", { id: ptyId });
      term.dispose();
      termRef.current = null;
    };
    // Mount once: cwd/startup are captured at spawn and never change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (active) termRef.current?.focus();
  }, [active]);

  return <div ref={hostRef} className="terminal-host" />;
}

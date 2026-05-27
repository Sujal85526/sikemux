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
// owns the PTY for its full lifetime. The xterm + WebGL context is
// mounted while the OWNING SESSION is foregrounded (sessionActive=true) —
// not just while this specific pane is visible. That way Alt+]/[ cycling
// within a project keeps every term's xterm warm, and revisits cost ~0
// (no boot, no pty_attach IPC, no snapshot replay).
//
// On session-switch (sessionActive flips false) we tear down the xterm
// and unsubscribe, which frees the WebGL context. That bounds memory and
// keeps us under WebKit's ~8-16 concurrent WebGL-context cap even at
// 20+ open projects with running agents.
//
// `active` (this specific pane being the visible one within the session)
// now only drives focus.
export function TerminalPane({
  cwd,
  startup,
  active,
  sessionActive,
}: {
  cwd?: string;
  startup?: string;
  active: boolean;
  /** Whether this terminal's OWNING SESSION is the foregrounded project
   *  session. Controls the xterm lifecycle: alive while true, torn down
   *  when it flips false. Defaults to `active` so call sites that don't
   *  differentiate (single-term contexts) get the legacy behavior. */
  sessionActive?: boolean;
}) {
  const shouldMount = sessionActive ?? active;
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

    // Startup line is handed to the backend; the reader task writes it
    // the moment the shell prints its first byte of output (i.e. when
    // the prompt appears and readline is actually accepting input).
    // The previous setTimeout(350ms) was a race dressed as a delay —
    // any slow rc (oh-my-zsh, p10k, work laptops) could land the write
    // before the shell was ready and lose the command.
    invoke<number>("pty_spawn", {
      cols: 80,
      rows: 24,
      cwd: cwd ?? null,
      startup: startup ?? null,
    }).then(
      (id) => {
        if (disposed) {
          void invoke("pty_kill", { id });
          return;
        }
        ptyIdRef.current = id;
        resolveReady(id);
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

  // The xterm + WebGL context live behind these refs so the
  // active-driven focus effect (below) can re-focus without remounting,
  // and so a boot in flight when the user navigates away knows whether
  // to skip the final `term.focus()`.
  const termRef = useRef<Terminal | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  // Once a pane has been activated at least once, we boot it eagerly on
  // subsequent session-active flips (instead of waiting for the user to
  // hit Alt+] back to it). Otherwise fresh sessions with many windows
  // would cold-boot every term immediately on selection, which is the
  // opposite of what we want.
  const everActiveRef = useRef(false);
  if (active) everActiveRef.current = true;
  const bootRef = useRef<() => void>(() => {});

  // ---- xterm lifecycle (keyed to OWNING SESSION being active) ----
  // The xterm stays alive across active=true/false flips inside the
  // session (Alt+] cycling) and only tears down when sessionActive flips
  // false (you switched to another project). This bounds the live WebGL
  // contexts to the active project's terms while keeping within-project
  // navigation instant.
  useEffect(() => {
    if (!shouldMount) return;
    const host = hostRef.current!;
    let disposed = false;
    let cleanup = () => {};

    const boot = async () => {
      if (disposed || termRef.current) return;
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

      termRef.current = term;
      // Only steal focus if the user is actually looking at this pane
      // right now. Reading activeRef means a boot that started while the
      // pane was active but completed after the user navigated away
      // won't yank focus back.
      if (activeRef.current) term.focus();

      cleanup = () => {
        unregisterTheme();
        ro.disconnect();
        dataSub.dispose();
        void invoke("pty_unsubscribe", { id: pid, subId });
        term.dispose();
        termRef.current = null;
      };
    };

    // Expose boot to the focus effect so a first-visit Alt+] (sessionActive
    // already true, active flipping false→true on a not-yet-booted pane)
    // can kick the boot off without us needing to re-trigger this whole
    // effect by depending on `active`.
    const fontsThenBoot = () =>
      void Promise.all([
        document.fonts.load('13px "JetBrainsMono Nerd Font"'),
        document.fonts.load('italic 13px "JetBrainsMono Nerd Font"'),
        document.fonts.load('bold 13px "JetBrainsMono Nerd Font"'),
      ]).then(boot, boot);
    bootRef.current = fontsThenBoot;

    // Eager-boot if the pane has been activated at least once. On first
    // session activation (everActiveRef still false), we defer until the
    // user navigates here — that's what keeps cold opens cheap when 4-6
    // windows would otherwise all boot simultaneously.
    if (everActiveRef.current) fontsThenBoot();

    return () => {
      disposed = true;
      bootRef.current = () => {};
      cleanup();
    };
  }, [shouldMount]);

  // ---- focus + lazy first-boot on active flips ----
  // Cheap: no dispose, no remount. If the pane has never booted (first
  // visit), kick the boot here so the user doesn't wait for sessionActive
  // to retoggle.
  useEffect(() => {
    if (!active) return;
    if (termRef.current) {
      termRef.current.focus();
    } else if (shouldMount) {
      bootRef.current();
    }
  }, [active, shouldMount]);

  return <div ref={hostRef} className="terminal-host" />;
}

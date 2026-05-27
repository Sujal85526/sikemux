import { useEffect, useRef, type RefObject } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Channel, invoke } from "@tauri-apps/api/core";
import { currentTheme, registerTerminal } from "../themes/bus";

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

/** Mounts an xterm.js terminal into `hostRef` and attaches it to the
 *  PTY whose id is delivered through `ptyReady`.
 *
 *  Lifecycle gating:
 *  - `shouldMount` drives mount/unmount of the xterm + WebGL context.
 *    When the owning session backgrounds (Alt+Tab to another project)
 *    the xterm is torn down, freeing its WebGL slot — that's how we
 *    stay under WebKit's ~8-16 concurrent-context cap with 20+ open
 *    projects.
 *  - `active` drives focus + first-visit boot. It never remounts; the
 *    xterm stays warm across Alt+] cycling within a session.
 *
 *  First-visit policy: a fresh session's panes don't all boot the
 *  moment shouldMount goes true. Only panes that have been activated
 *  at least once (`everActive`) boot eagerly on a re-foreground; the
 *  rest wait until the user navigates to them, which the focus effect
 *  kicks off via `bootRef`.
 *
 *  Also handles, inside the boot:
 *  - snapshot-vs-stream race: chunks arriving while pty_attach is
 *    in-flight are buffered and replayed after the snapshot writes
 *  - input batching: one pty_write per microtask instead of one per
 *    keystroke
 *  - macOS Cmd-/Opt-chord interception that xterm's default handler eats
 */
export function useXterm(opts: {
  hostRef: RefObject<HTMLDivElement | null>;
  ptyReady: RefObject<Promise<number> | null>;
  shouldMount: boolean;
  active: boolean;
}): void {
  const { hostRef, ptyReady, shouldMount, active } = opts;
  const termRef = useRef<Terminal | null>(null);
  // Captures `active` for the boot completion: if the user navigated
  // away mid-boot we must not steal focus when the xterm finally renders.
  const activeRef = useRef(active);
  activeRef.current = active;
  // Sticky "has this pane ever been visited?" flag. Drives the boot
  // decision on subsequent session-active flips so cold session opens
  // don't spin up 4-6 xterms at once.
  const everActiveRef = useRef(false);
  if (active) everActiveRef.current = true;
  // Escape hatch for the focus effect — lets a first-visit Alt+] kick
  // boot off without forcing this effect to depend on `active` (which
  // would tear down + remount on every focus flip).
  const bootRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!shouldMount) return;
    const host = hostRef.current!;
    let disposed = false;
    let cleanup = () => {};

    const boot = async () => {
      if (disposed || termRef.current) return;
      const pid = await ptyReady.current!.catch(() => null);
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
        // WebGL unavailable — xterm falls back to its canvas renderer.
      }
      fit.fit();

      // Sync parser geometry to actual xterm dimensions BEFORE snapshot
      // so the returned grid matches our cols/rows. Otherwise reattach
      // lands on a mis-sized canvas and the first paint looks rewrapped.
      await invoke("pty_resize", {
        id: pid,
        cols: term.cols,
        rows: term.rows,
      });

      // Buffer live chunks arriving while pty_attach is in flight / before
      // we've written the snapshot. They're all NEW bytes (the parser lock
      // ensures no overlap with the snapshot), so we replay in order right
      // after the snapshot write.
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

      // Coalesce onData chunks within one microtask into a single
      // pty_write IPC. Paste-heavy / fast-typing flows used to do 100s
      // of round-trips per second; now it's one per frame.
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
      // right now. Reading activeRef here (not the `active` captured
      // when boot started) means a boot that started while the pane
      // was active but completed after the user navigated away won't
      // yank focus back.
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

    const fontsThenBoot = () =>
      void Promise.all([
        document.fonts.load('13px "JetBrainsMono Nerd Font"'),
        document.fonts.load('italic 13px "JetBrainsMono Nerd Font"'),
        document.fonts.load('bold 13px "JetBrainsMono Nerd Font"'),
      ]).then(boot, boot);
    bootRef.current = fontsThenBoot;

    // Eager-boot iff this pane has been activated at least once. On the
    // first session activation (everActiveRef still false), defer until
    // the user navigates here — keeps cold session opens cheap when
    // 4-6 windows would otherwise all boot simultaneously.
    if (everActiveRef.current) fontsThenBoot();

    return () => {
      disposed = true;
      bootRef.current = () => {};
      cleanup();
    };
  }, [shouldMount, hostRef, ptyReady]);

  // Focus + lazy first-boot on active flips. Cheap: no dispose, no
  // remount. If the pane has never booted (first visit), kick boot here
  // so the user doesn't have to wait for sessionActive to retoggle.
  useEffect(() => {
    if (!active) return;
    if (termRef.current) {
      termRef.current.focus();
    } else if (shouldMount) {
      bootRef.current();
    }
  }, [active, shouldMount]);
}

import { useRef } from "react";
import "@xterm/xterm/css/xterm.css";
import { usePty } from "./usePty";
import { useXterm } from "./useXterm";

// PTY screen state lives in a Rust-side `vt100::Parser`. This pane owns
// the PTY for its entire mount; the xterm + WebGL context is mounted
// only while the OWNING SESSION is foregrounded (not just while this
// specific pane is the visible one within the session).
//
// Two refs, one host, two hooks:
//   usePty   — spawn on mount, kill on unmount, drag-drop wiring
//   useXterm — xterm boot/teardown gated on shouldMount, focus on active
//
// `active`         — this pane is the visible one inside its session
// `sessionActive`  — the session itself is the foregrounded one
//
// Splitting them means within-session navigation (Alt+]) keeps every
// term's xterm warm — revisits cost ~0 IPC. Switching projects tears
// down the previous project's xterms, freeing WebGL contexts so we
// stay under WebKit's ~8-16 concurrent-context cap even at 20+ open
// projects with running agents.
export function TerminalPane({
  cwd,
  startup,
  active,
  sessionActive,
}: {
  cwd?: string;
  startup?: string;
  active: boolean;
  /** Defaults to `active` so callers without per-session granularity
   *  (single-term contexts) get the legacy "alive only while visible"
   *  behaviour for free. */
  sessionActive?: boolean;
}) {
  const shouldMount = sessionActive ?? active;
  const hostRef = useRef<HTMLDivElement>(null);
  const ptyReady = usePty({ cwd, startup, hostRef });
  useXterm({ hostRef, ptyReady, shouldMount, active });

  return <div ref={hostRef} className="terminal-host" />;
}

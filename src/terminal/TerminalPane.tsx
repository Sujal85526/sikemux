import { useRef } from "react";
import "@xterm/xterm/css/xterm.css";
import { usePty } from "./usePty";
import { useXterm } from "./useXterm";

// PTY screen state lives in a Rust-side `vt100::Parser`. This pane owns
// the PTY for its entire mount after first visibility; the xterm + WebGL
// context is mounted only while this pane is visible.
//
// Two refs, one host, two hooks:
//   usePty   — lazy spawn, kill on unmount, drag-drop wiring
//   useXterm — xterm boot/teardown gated on visibility, focus on active
//
// `active`  — this pane has focus
// `visible` — this pane is actually shown in the current window/agent tab
//
// Hidden terminal tabs keep their backend PTY alive but release xterm's
// DOM/WebGL work until the user brings them back.
export function TerminalPane({
  cwd,
  startup,
  active,
  visible = active,
  spawnWhen = visible,
}: {
  cwd?: string;
  startup?: string;
  active: boolean;
  visible?: boolean;
  /** First selection boots the PTY. After that the PTY stays alive until
   *  the pane unmounts, even when this flips back to false. */
  spawnWhen?: boolean;
}) {
  const shouldMount = visible;
  const hostRef = useRef<HTMLDivElement>(null);
  const ptyReady = usePty({ cwd, startup, hostRef, spawnWhen });
  useXterm({ hostRef, ptyReady, shouldMount, active });

  return <div ref={hostRef} className="terminal-host" />;
}

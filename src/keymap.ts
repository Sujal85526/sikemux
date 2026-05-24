import { useEffect } from "react";
import { useWorkspace } from "./state/workspace";

// Maps M-i/r/g to the named windows of a project session.
const WINDOW_KEYS: Record<string, string> = {
  KeyI: "files",
  KeyR: "term",
  KeyG: "git",
};

// Alt-driven keybindings, mirroring the user's tmux setup. We key off
// `event.code` (physical key) so macOS option-as-alt remapping of the
// printable character doesn't matter. Matched chords are swallowed before
// they reach Xterm; everything else passes through to the terminal.
//
// Cmd-P (Telescope-style file finder) and Cmd-, (settings) ride on meta,
// not alt — they need to work from inside terminal panes where alt-chords
// are too easy to fat-finger.
export function useKeymap(): void {
  useEffect(() => {
    const meta = (e: KeyboardEvent): void => {
      if (!e.metaKey || e.altKey || e.ctrlKey) return;
      const w = useWorkspace.getState();
      if (e.code === "KeyP" && !e.shiftKey) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (w.filePaletteOpen) w.closeFilePalette();
        else w.openFilePalette();
      } else if (e.code === "Comma") {
        e.preventDefault();
        e.stopImmediatePropagation();
        w.toggleSettings();
      }
    };
    window.addEventListener("keydown", meta, { capture: true });
    return () =>
      window.removeEventListener("keydown", meta, { capture: true });
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (!e.altKey || e.metaKey || e.ctrlKey) return;
      const w = useWorkspace.getState();
      if (
        w.pickerOpen ||
        w.filePaletteOpen ||
        w.agentPaletteOpen ||
        w.settingsOpen
      )
        return; // modals own the keyboard
      const shift = e.shiftKey;
      let handled = true;

      switch (e.code) {
        case "Backslash": // M-\  vertical split
          w.splitActivePane("row");
          break;
        case "Minus": // M--  horizontal split
          w.splitActivePane("column");
          break;
        case "KeyH":
          shift ? w.resizeActivePane("left") : w.moveFocus("left");
          break;
        case "KeyJ":
          shift ? w.resizeActivePane("down") : w.moveFocus("down");
          break;
        case "KeyK":
          shift ? w.resizeActivePane("up") : w.moveFocus("up");
          break;
        case "KeyL":
          shift ? w.resizeActivePane("right") : w.moveFocus("right");
          break;
        case "KeyZ": // M-z  zoom toggle
          w.toggleZoom();
          break;
        case "KeyW": // M-w  close pane (closes window when last)
          w.closeActivePane();
          break;
        case "KeyN": {
          // M-n context-aware:
          //   project → new terminal window in the project
          //   command → spawn a fresh command session (scratch terminal)
          //   ssh     → open the ssh picker (you wouldn't add panes to a
          //             remote session — instead you open another host)
          const active = w.sessions[w.activeSessionId];
          if (active?.kind === "ssh") w.openPicker("ssh");
          else if (active?.kind === "command") w.createCommandSession();
          else w.newWindow();
          break;
        }
        case "Period": // M-.  next window
          w.selectWindowRelative(1);
          break;
        case "Comma": // M-,  previous window (M-p is now projects picker)
          w.selectWindowRelative(-1);
          break;
        case "KeyP": // M-p  projects-only picker
          w.openPicker("projects");
          break;
        case "KeyS":
          // M-s        everything (projects + command + ssh hosts)
          // M-Shift-s  ssh only
          w.openPicker(shift ? "ssh" : "all");
          break;
        case "KeyA":
          // M-a  open (or focus) the AWS master session
          w.openAwsSession();
          break;
        case "KeyQ": // M-q  close session
          w.closeActiveSession();
          break;
        case "Tab": // M-Tab  cycle sessions within group
          w.cycleSession(shift ? -1 : 1);
          break;
        case "Backquote": // M-`  cycle sessions backward
          w.cycleSession(-1);
          break;
        case "KeyI":
        case "KeyR":
        case "KeyG": // M-i/r/g  jump to a named window
          w.selectWindowByName(WINDOW_KEYS[e.code]);
          break;
        case "KeyC": // M-c  focus the agents view
        case "Slash": // M-/  alias for M-c (some WMs swallow Alt+C)
          w.focusAgents();
          break;
        default:
          if (/^Digit[1-9]$/.test(e.code)) {
            w.selectWindowByIndex(Number(e.code.slice(5)) - 1);
          } else {
            handled = false;
          }
      }

      if (handled) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };

    window.addEventListener("keydown", handler, { capture: true });
    return () =>
      window.removeEventListener("keydown", handler, { capture: true });
  }, []);
}

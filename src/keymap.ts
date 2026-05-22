import { useEffect } from "react";
import { useWorkspace } from "./state/workspace";

// Maps M-i/r/g to the named windows of a project session.
const WINDOW_KEYS: Record<string, string> = {
  KeyI: "files",
  KeyR: "run",
  KeyG: "git",
};

// Alt-driven keybindings, mirroring the user's tmux setup. We key off
// `event.code` (physical key) so macOS option-as-alt remapping of the
// printable character doesn't matter. Matched chords are swallowed before
// they reach Xterm; everything else passes through to the terminal.
export function useKeymap(): void {
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (!e.altKey || e.metaKey || e.ctrlKey) return;
      const w = useWorkspace.getState();
      if (w.pickerOpen) return; // the picker owns the keyboard while open
      const shift = e.shiftKey;
      let handled = true;

      switch (e.code) {
        case "Backslash": // M-\  vertical split (side-by-side)
          w.splitActivePane("row");
          break;
        case "Minus": // M--  horizontal split (stacked)
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
        case "KeyN": // M-n  new window
          w.newWindow();
          break;
        case "KeyP": // M-p  previous window
          w.selectWindowRelative(-1);
          break;
        case "Period": // M-.  next window
          w.selectWindowRelative(1);
          break;
        case "KeyS": // M-s  sesh picker
          w.openPicker();
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

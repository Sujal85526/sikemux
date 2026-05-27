import { useEffect } from "react";
import * as cmd from "./state/commands";
import { getState } from "./state/store";

// Maps M-i/r/g/f to the named windows of a project session.
const WINDOW_KEYS: Record<string, string> = {
    KeyI: "files",
    KeyR: "term",
    KeyG: "git",
    KeyF: "search",
};

// Alt-driven keybindings, mirroring the user's tmux setup. Keys off the
// physical `event.code` so macOS option-as-alt remapping doesn't matter.
// Cmd-P and Cmd-, ride on meta so they work from inside terminal panes
// where alt-chords are too easy to fat-finger.
export function useKeymap(): void {
    useEffect(() => {
        const meta = (e: KeyboardEvent): void => {
            if (!e.metaKey || e.altKey || e.ctrlKey) return;
            if (e.code === "KeyP" && !e.shiftKey) {
                e.preventDefault();
                e.stopImmediatePropagation();
                if (getState().filePaletteOpen) cmd.closeFilePalette();
                else cmd.openFilePalette();
            } else if (e.code === "KeyF" && e.shiftKey) {
                // Cmd/Ctrl+Shift+F → jump to the project's search window. Project
                // sessions only (no-op elsewhere — see focusGlobalSearch).
                e.preventDefault();
                e.stopImmediatePropagation();
                cmd.focusGlobalSearch();
            } else if (e.code === "Comma") {
                e.preventDefault();
                e.stopImmediatePropagation();
                cmd.toggleSettings();
            }
        };
        window.addEventListener("keydown", meta, { capture: true });
        return () => window.removeEventListener("keydown", meta, { capture: true });
    }, []);

    useEffect(() => {
        const handler = (e: KeyboardEvent): void => {
            if (!e.altKey || e.metaKey || e.ctrlKey) return;
            const st = getState();
            if (st.pickerOpen || st.filePaletteOpen || st.agentPaletteOpen || st.settingsOpen) return; // modals own the keyboard
            const shift = e.shiftKey;
            let handled = true;

            switch (e.code) {
                case "Backslash":
                    cmd.splitActivePane("row");
                    break;
                case "Minus":
                    cmd.splitActivePane("column");
                    break;
                case "KeyH":
                    shift ? cmd.resizeActivePane("left") : cmd.moveFocus("left");
                    break;
                case "KeyJ":
                    shift ? cmd.resizeActivePane("down") : cmd.moveFocus("down");
                    break;
                case "KeyK":
                    shift ? cmd.resizeActivePane("up") : cmd.moveFocus("up");
                    break;
                case "KeyL":
                    shift ? cmd.resizeActivePane("right") : cmd.moveFocus("right");
                    break;
                case "KeyZ":
                    cmd.toggleZoom();
                    break;
                case "KeyW":
                    cmd.closeActivePane();
                    break;
                case "KeyN": {
                    // Context-aware new:
                    //   project → new terminal window
                    //   command → fresh command session
                    //   ssh     → opens the ssh picker
                    const active = st.sessions[st.activeSessionId];
                    if (active?.kind === "ssh") cmd.openPicker("ssh");
                    else if (active?.kind === "command") cmd.createCommandSession();
                    else cmd.newWindow();
                    break;
                }
                case "BracketRight":
                    cmd.selectWindowRelative(1);
                    break;
                case "BracketLeft":
                    cmd.selectWindowRelative(-1);
                    break;
                case "KeyP":
                    cmd.openPicker("projects");
                    break;
                case "KeyS":
                    cmd.openPicker(shift ? "ssh" : "all");
                    break;
                case "KeyA":
                    cmd.openAwsSession();
                    break;
                case "KeyQ":
                    cmd.closeActiveSession();
                    break;
                case "Tab":
                    // Shift+Tab → next session-kind group (Projects → SSH → Cloud →
                    // CI/CD → Command). Plain Tab → next session within the current
                    // group. Alt+Backquote stays as the reverse-within-group.
                    if (shift) cmd.cycleSessionGroup(1);
                    else cmd.cycleSession(1);
                    break;
                case "Backquote":
                    cmd.cycleSession(-1);
                    break;
                case "KeyI":
                case "KeyR":
                case "KeyG":
                case "KeyF":
                    cmd.selectWindowByName(WINDOW_KEYS[e.code]);
                    break;
                case "KeyC":
                case "Slash":
                    cmd.focusAgents();
                    break;
                default:
                    if (/^Digit[1-9]$/.test(e.code)) {
                        // Side-rail order: files=1, term=2, git=3, agents=4, search=5.
                        // The windows array in state is still [files, term, git, search]
                        // (don't reorder persisted state), so we map the digit through
                        // the rail-visible order instead of straight to the array.
                        const n = Number(e.code.slice(5));
                        if (n === 4) cmd.focusAgents();
                        else if (n === 5) cmd.selectWindowByName("search");
                        else cmd.selectWindowByIndex(n - 1);
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
        return () => window.removeEventListener("keydown", handler, { capture: true });
    }, []);
}

import { useEffect } from "react";
import * as cmd from "./state/commands";
import { emit } from "./state/bus";
import { getState } from "./state/store";

const WINDOW_KEYS: Record<string, string> = {
    KeyI: "files",
    KeyR: "term",
    KeyG: "git",
    KeyF: "search",
};

function isTerminalKeyTarget(e: KeyboardEvent): boolean {
    const target = e.target instanceof Element ? e.target : document.activeElement;
    return !!target?.closest?.(".xterm");
}

export function useKeymap(): void {
    useEffect(() => {
        const meta = (e: KeyboardEvent): void => {
            if (!e.metaKey || e.altKey || e.ctrlKey) return;
            if (e.code === "KeyP" && !e.shiftKey) {
                e.preventDefault();
                e.stopImmediatePropagation();
                const st = getState();
                const active = st.sessions[st.activeSessionId];
                if (active?.kind === "rundeck") {
                    if (st.rundeckJobPaletteOpen) cmd.closeRundeckJobPalette();
                    else cmd.openRundeckJobPalette();
                } else if (st.filePaletteOpen) {
                    cmd.closeFilePalette();
                } else {
                    cmd.openFilePalette();
                }
            } else if (e.code === "KeyS" && !e.shiftKey) {
                // ⌘S saves the active Bruno request; elsewhere it's left alone.
                if (getState().sessions[getState().activeSessionId]?.kind === "bruno") {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    cmd.brunoSaveActive();
                }
            } else if (e.code === "Enter" || e.code === "NumpadEnter") {
                // ⌘↵ sends the active Bruno request.
                const st = getState();
                const s = st.sessions[st.activeSessionId];
                if (s?.kind === "bruno") {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    emit({ type: "bruno-run", sessionId: s.id });
                }
            } else if (e.code === "KeyF" && e.shiftKey) {
                e.preventDefault();
                e.stopImmediatePropagation();
                const sel = window.getSelection()?.toString() ?? "";
                cmd.focusGlobalSearch(sel.trim() ? sel : undefined);
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
            if (st.pickerOpen || st.filePaletteOpen || st.agentPaletteOpen || st.rundeckJobPaletteOpen || st.settingsOpen) return; // modals own the keyboard
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
                    // Let terminal apps (pi, shells, editors) receive Alt+J. Pi uses it
                    // as a reliable multiline prompt fallback when Shift+Enter is not
                    // available. Alt+Shift+J still resizes panes.
                    if (!shift && isTerminalKeyTarget(e)) handled = false;
                    else shift ? cmd.resizeActivePane("down") : cmd.moveFocus("down");
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
                    cmd.closeActiveFocusTarget();
                    break;
                case "KeyN": {
                    const active = st.sessions[st.activeSessionId];
                    if (active?.view === "agent") cmd.openAgentPalette();
                    else if (active?.kind === "project") cmd.newWindow();
                    else if (active?.kind === "command") cmd.createCommandSession();
                    else if (active?.kind === "ssh") cmd.openPicker("ssh");
                    else if (active?.kind === "aws") cmd.openAwsSession();
                    else if (active?.kind === "rundeck") cmd.openRundeckSession();
                    else if (active?.kind === "bruno") void cmd.openBrunoFolder();
                    else handled = false;
                    break;
                }
                case "BracketRight":
                    cmd.selectWindowRelative(1);
                    break;
                case "BracketLeft":
                    cmd.selectWindowRelative(-1);
                    break;
                case "Period":
                    cmd.cycleTabs(1);
                    break;
                case "Comma":
                    cmd.cycleTabs(-1);
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
                case "KeyB":
                    void cmd.openBrunoFolder();
                    break;
                case "KeyQ":
                    cmd.closeActiveSession();
                    break;
                case "Tab":
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

import { useEffect, useRef, type RefObject } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Channel, invoke } from "@tauri-apps/api/core";
import { currentTheme, registerTerminal } from "../themes/bus";

const FONT = '"JetBrainsMono NF", "JetBrainsMono Nerd Font", monospace';
const FONT_WEIGHT = 500;
const FONT_WEIGHT_BOLD = 700;
const SCROLLBACK = 10_000;

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

export function useXterm(opts: {
    hostRef: RefObject<HTMLDivElement | null>;
    ptyReady: RefObject<Promise<number> | null>;
    shouldMount: boolean;
    active: boolean;
}): void {
    const { hostRef, ptyReady, shouldMount, active } = opts;
    const termRef = useRef<Terminal | null>(null);
    const bootingRef = useRef(false);
    const activeRef = useRef(active);
    activeRef.current = active;
    const bootRef = useRef<() => void>(() => {});

    useEffect(() => {
        if (!shouldMount) return;
        const host = hostRef.current!;
        let disposed = false;
        let cleanup = () => {};

        const boot = async () => {
            if (disposed || termRef.current || bootingRef.current) return;
            bootingRef.current = true;
            const ready = ptyReady.current;
            if (!ready) {
                bootingRef.current = false;
                return;
            }
            const pid = await ready.catch(() => null);
            if (disposed || pid === null) {
                bootingRef.current = false;
                return;
            }

            const term = new Terminal({
                fontFamily: FONT,
                fontSize: 13,
                fontWeight: FONT_WEIGHT,
                fontWeightBold: FONT_WEIGHT_BOLD,
                lineHeight: 1.0,
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
            // Keep xterm on its default DOM renderer. The WebGL renderer is fast,
            // but in WKWebView it can leave stale atlas cells during high-churn
            // prompt redraws (notably zsh-autosuggestions/right-prompt repaint),
            // which looks like duplicated words while typing. Correctness beats
            // GPU acceleration for terminal input rendering.
            fit.fit();

            await invoke("pty_resize", {
                id: pid,
                cols: term.cols,
                rows: term.rows,
            });

            let snapshotApplied = false;
            const pending: number[][] = [];
            const channel = new Channel<number[]>();
            let outputFrame: number | null = null;
            const outputPending: number[][] = [];
            const flushOutput = () => {
                outputFrame = null;
                if (disposed || outputPending.length === 0) return;
                if (outputPending.length === 1) {
                    term.write(new Uint8Array(outputPending.pop()!));
                    return;
                }
                let total = 0;
                for (const chunk of outputPending) total += chunk.length;
                const merged = new Uint8Array(total);
                let offset = 0;
                for (const chunk of outputPending.splice(0)) {
                    merged.set(chunk, offset);
                    offset += chunk.length;
                }
                term.write(merged);
            };
            const scheduleOutput = () => {
                if (outputFrame == null) outputFrame = window.requestAnimationFrame(flushOutput);
            };
            const writeChunk = (chunk: number[]) => {
                if (chunk.length === 0) {
                    flushOutput();
                    term.write("\r\n\x1b[38;5;245m[process exited]\x1b[0m\r\n");
                    return;
                }
                outputPending.push(chunk);
                scheduleOutput();
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
                bootingRef.current = false;
                return;
            }
            if (snapshot.length > 0) term.write(new Uint8Array(snapshot));
            snapshotApplied = true;
            for (const chunk of pending) writeChunk(chunk);
            pending.length = 0;

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
                if (e.key === "Enter" && e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
                    void invoke("pty_write", { id: pid, data: "\x1b[13;2u" });
                    e.preventDefault();
                    e.stopPropagation();
                    return false;
                }
                const keyParts: string[] = [];
                if (e.metaKey) keyParts.push("Meta");
                if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Backspace")) {
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
            bootingRef.current = false;
            if (activeRef.current) term.focus();

            cleanup = () => {
                unregisterTheme();
                ro.disconnect();
                dataSub.dispose();
                if (outputFrame != null) window.cancelAnimationFrame(outputFrame);
                outputPending.length = 0;
                pending.length = 0;
                void invoke("pty_unsubscribe", { id: pid, subId });
                term.dispose();
                termRef.current = null;
            };
        };

        const fontsThenBoot = () =>
            void Promise.all([
                document.fonts.load(`${FONT_WEIGHT} 13px "JetBrainsMono NF"`),
                document.fonts.load(`italic ${FONT_WEIGHT} 13px "JetBrainsMono NF"`),
                document.fonts.load(`${FONT_WEIGHT_BOLD} 13px "JetBrainsMono NF"`),
                document.fonts.load(`italic ${FONT_WEIGHT_BOLD} 13px "JetBrainsMono NF"`),
            ]).then(boot, boot);
        bootRef.current = fontsThenBoot;

        fontsThenBoot();

        return () => {
            disposed = true;
            bootRef.current = () => {};
            cleanup();
        };
    }, [shouldMount, hostRef, ptyReady]);

    useEffect(() => {
        if (!active) return;
        if (termRef.current) {
            termRef.current.focus();
        } else if (shouldMount) {
            bootRef.current();
        }
    }, [active, shouldMount]);
}

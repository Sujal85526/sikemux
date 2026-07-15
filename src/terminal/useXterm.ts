import { useEffect, useRef, type RefObject } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Channel, invoke } from "@tauri-apps/api/core";
import { currentTheme, registerTerminal } from "../themes/bus";
import {
    completeInitialReplay,
    initialReplayScrollState,
    noteUserViewportGesture,
    replaySerializedNormalBuffer,
    serializeNormalBuffer,
    type SerializedNormalBuffer,
} from "./sessionState";
import { alternateScreenWheelFallbackSequence } from "./wheelNavigation";

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
    alternateScreen: boolean;
}

export function useXterm(opts: {
    hostRef: RefObject<HTMLDivElement | null>;
    ptyReady: RefObject<Promise<number> | null>;
    shouldMount: boolean;
    active: boolean;
    visible: boolean;
}): void {
    const { hostRef, ptyReady, shouldMount, active, visible } = opts;
    const termRef = useRef<Terminal | null>(null);
    const bootingRef = useRef(false);
    const activeRef = useRef(active);
    activeRef.current = active;
    const visibleRef = useRef(visible);
    visibleRef.current = visible;
    const bootRef = useRef<() => void>(() => {});
    const resizeRef = useRef<() => void>(() => {});
    const serializedNormalRef = useRef<SerializedNormalBuffer | null>(null);

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
                scrollOnUserInput: true,
                smoothScrollDuration: 0,
            });
            const unregisterTheme = registerTerminal(term);
            const fit = new FitAddon();
            const serializer = new SerializeAddon();
            term.loadAddon(fit);
            term.loadAddon(serializer);
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
            let outputBusy = false;
            let closing = false;
            let finalized = false;
            let replayScrollState = initialReplayScrollState();
            let initialReplayOutputPending = false;
            const outputPending: Uint8Array[] = [];
            const encoder = new TextEncoder();
            const isAtBottom = () => {
                const buf = term.buffer.active;
                return buf.viewportY >= buf.baseY;
            };
            const onUserViewportGesture = () => {
                replayScrollState = noteUserViewportGesture(replayScrollState);
            };
            term.attachCustomWheelEventHandler(() => {
                onUserViewportGesture();
                return true;
            });
            const onWheel = (event: WheelEvent) => {
                const sequence = alternateScreenWheelFallbackSequence({
                    defaultPrevented: event.defaultPrevented,
                    bufferType: term.buffer.active.type,
                    mouseTrackingMode: term.modes.mouseTrackingMode,
                    applicationCursorKeysMode: term.modes.applicationCursorKeysMode,
                    deltaX: event.deltaX,
                    deltaY: event.deltaY,
                });
                if (sequence === null) return;

                // Alternate-screen TUIs have no xterm scrollback. xterm turns
                // wheel gestures into cursor keys, but tiny trackpad deltas can
                // round down to zero; guarantee movement in that fallback case.
                event.preventDefault();
                void invoke("pty_write", { id: pid, data: sequence });
            };
            host.addEventListener("wheel", onWheel, { passive: false });
            const viewport = host.querySelector<HTMLElement>(".xterm-viewport");
            const terminalElement = term.element;
            const onViewportKeyDown = (event: KeyboardEvent) => {
                if (event.key === "PageUp" || event.key === "PageDown" || event.key === "Home" || event.key === "End") {
                    onUserViewportGesture();
                }
            };
            viewport?.addEventListener("pointerdown", onUserViewportGesture);
            terminalElement?.addEventListener("touchstart", onUserViewportGesture, { capture: true, passive: true });
            terminalElement?.addEventListener("keydown", onViewportKeyDown, { capture: true });
            const finalizeCleanup = () => {
                if (finalized || outputBusy || outputPending.length > 0) return;
                finalized = true;
                try {
                    serializedNormalRef.current = serializeNormalBuffer(serializer, pid, SCROLLBACK);
                } catch (error) {
                    serializedNormalRef.current = null;
                    console.warn("terminal normal-buffer serialization failed", error);
                }
                term.dispose();
            };
            const flushOutput = () => {
                outputFrame = null;
                if ((disposed && !closing) || outputBusy || outputPending.length === 0) return;
                const completesInitialReplay = initialReplayOutputPending;
                initialReplayOutputPending = false;
                let total = 0;
                for (const chunk of outputPending) total += chunk.length;
                const merged = new Uint8Array(total);
                let offset = 0;
                for (const chunk of outputPending.splice(0)) {
                    merged.set(chunk, offset);
                    offset += chunk.length;
                }
                outputBusy = true;
                term.write(merged, () => {
                    outputBusy = false;
                    if (completesInitialReplay) {
                        const completion = completeInitialReplay(replayScrollState);
                        replayScrollState = completion.state;
                        if (completion.shouldScrollToBottom && !disposed) term.scrollToBottom();
                    }
                    if (outputPending.length > 0) {
                        if (closing) flushOutput();
                        else scheduleOutput();
                    } else if (closing) {
                        finalizeCleanup();
                    }
                });
            };
            const scheduleOutput = () => {
                if (!outputBusy && outputFrame == null) outputFrame = window.requestAnimationFrame(flushOutput);
            };
            const writeBytes = (bytes: Uint8Array) => {
                if (bytes.length === 0) return;
                outputPending.push(bytes);
                scheduleOutput();
            };
            const writeChunk = (chunk: number[]) => {
                if (chunk.length === 0) {
                    writeBytes(encoder.encode("\r\n\x1b[38;5;245m[process exited]\x1b[0m\r\n"));
                    return;
                }
                writeBytes(new Uint8Array(chunk));
            };
            channel.onmessage = (chunk) => {
                if (!snapshotApplied) {
                    pending.push(chunk);
                    return;
                }
                writeChunk(chunk);
            };

            const { subId, snapshot, alternateScreen } = await invoke<AttachResult>("pty_attach", {
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
            const serializedNormal = replaySerializedNormalBuffer(serializedNormalRef.current, pid, alternateScreen);
            if (serializedNormal !== null) writeBytes(encoder.encode(serializedNormal));
            if (snapshot.length > 0) writeChunk(snapshot);
            snapshotApplied = true;
            for (const chunk of pending) writeChunk(chunk);
            pending.length = 0;
            initialReplayOutputPending = outputPending.length > 0;
            if (!initialReplayOutputPending) replayScrollState = completeInitialReplay(replayScrollState).state;

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
                if (e.code === "KeyR" && e.metaKey && e.altKey && !e.ctrlKey && !e.shiftKey) {
                    void invoke("pty_reset_modes", { id: pid });
                    e.preventDefault();
                    e.stopPropagation();
                    return false;
                }
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

            let resizeFrame: number | null = null;
            let lastCols = term.cols;
            let lastRows = term.rows;
            const resizeNow = () => {
                resizeFrame = null;
                if (host.clientWidth === 0 || host.clientHeight === 0) return;
                const stickToBottom = isAtBottom();
                fit.fit();
                if (stickToBottom) term.scrollToBottom();
                if (term.cols === lastCols && term.rows === lastRows) return;
                lastCols = term.cols;
                lastRows = term.rows;
                void invoke("pty_resize", {
                    id: pid,
                    cols: term.cols,
                    rows: term.rows,
                });
            };
            const resize = () => {
                if (resizeFrame == null) resizeFrame = window.requestAnimationFrame(resizeNow);
            };
            resizeRef.current = resize;
            const ro = new ResizeObserver(resize);
            ro.observe(host);

            termRef.current = term;
            bootingRef.current = false;
            if (visibleRef.current) window.requestAnimationFrame(resize);
            if (activeRef.current) term.focus();

            cleanup = () => {
                if (closing) return;
                closing = true;
                resizeRef.current = () => {};
                unregisterTheme();
                ro.disconnect();
                host.removeEventListener("wheel", onWheel);
                viewport?.removeEventListener("pointerdown", onUserViewportGesture);
                terminalElement?.removeEventListener("touchstart", onUserViewportGesture, { capture: true });
                terminalElement?.removeEventListener("keydown", onViewportKeyDown, { capture: true });
                dataSub.dispose();
                if (outputFrame != null) window.cancelAnimationFrame(outputFrame);
                outputFrame = null;
                if (resizeFrame != null) window.cancelAnimationFrame(resizeFrame);
                pending.length = 0;
                channel.onmessage = () => {};
                void invoke("pty_unsubscribe", { id: pid, subId });
                termRef.current = null;
                if (outputBusy) return;
                if (outputPending.length > 0) flushOutput();
                else finalizeCleanup();
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
        if (!visible) return;
        if (termRef.current) {
            window.requestAnimationFrame(resizeRef.current);
        } else if (shouldMount) {
            bootRef.current();
        }
    }, [visible, shouldMount]);

    useEffect(() => {
        if (!active) return;
        if (termRef.current) {
            window.requestAnimationFrame(resizeRef.current);
            termRef.current.focus();
        } else if (shouldMount) {
            bootRef.current();
        }
    }, [active, shouldMount]);
}

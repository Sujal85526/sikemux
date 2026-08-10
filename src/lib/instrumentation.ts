import { INPUT_TO_NEXT_FRAME_METRIC, performanceTelemetry, type PerformanceMetadata, type PerformanceTelemetry } from "./performance";

export const ACTION_METRIC = "action.execute";
export const EVENT_LOOP_HANG_METRIC = "event-loop.hang";
export const NEXT_FRAME_PROXY = "next-animation-frame-callback";

export function scheduleNextFrame(callback: () => void): void {
    if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
        window.requestAnimationFrame(callback);
        return;
    }
    queueMicrotask(callback);
}

export function recordNextFrameProxy(input: string, metadata: PerformanceMetadata = {}): void {
    performanceTelemetry.recordInputToNextFrame(input, scheduleNextFrame, {
        ...metadata,
        measurement: NEXT_FRAME_PROXY,
    });
}

/** Measure one application action without retaining its arguments or result. */
export function runMeasuredAction<T>(action: string, source: string, execute: () => T): T {
    const span = performanceTelemetry.startTrace(ACTION_METRIC, { action, source });
    try {
        const result = execute();
        const recorded = performanceTelemetry.endSpan(span, { outcome: "success" });
        if (recorded) performanceTelemetry.recordLatency(ACTION_METRIC, recorded.durationMs);
        recordNextFrameProxy(action, { source });
        return result;
    } catch (error) {
        const recorded = performanceTelemetry.endSpan(span, { outcome: "error" });
        if (recorded) performanceTelemetry.recordLatency(ACTION_METRIC, recorded.durationMs);
        throw error;
    }
}

type TimerHandle = unknown;

export interface EventLoopMonitorOptions {
    intervalMs?: number;
    thresholdMs?: number;
    now?: () => number;
    visible?: () => boolean;
    schedule?: (callback: () => void, delayMs: number) => TimerHandle;
    cancel?: (handle: TimerHandle) => void;
    telemetry?: PerformanceTelemetry;
}

export interface NativeUiHeartbeatOptions {
    readonly send: (visible: boolean, heartbeat: number) => void | PromiseLike<void>;
    readonly intervalMs?: number;
    readonly visible?: () => boolean;
    readonly schedule?: (callback: () => void, delayMs: number) => TimerHandle;
    readonly cancel?: (handle: TimerHandle) => void;
    readonly addLifecycleListener?: (event: "visibilitychange" | "pageshow" | "pagehide", listener: () => void) => () => void;
    readonly onError?: () => void;
}

export const NATIVE_UI_HEARTBEAT_INTERVAL_MS = 500;
const MAX_NATIVE_UI_HEARTBEAT = 0xffff_ffff;

function defaultLifecycleListener(event: "visibilitychange" | "pageshow" | "pagehide", listener: () => void): () => void {
    if (typeof document === "undefined" || (event !== "visibilitychange" && typeof window === "undefined")) return () => {};
    const target: Document | Window = event === "visibilitychange" ? document : window;
    target.addEventListener(event, listener);
    return () => target.removeEventListener(event, listener);
}

/**
 * Keep the native watchdog informed without creating an IPC backlog. A pulse
 * never overlaps the previous send; lifecycle changes collapse to the latest
 * visibility state, while `pagehide` disarms immediately when it can run.
 */
export function startNativeUiHeartbeat(options: NativeUiHeartbeatOptions): () => void {
    if (typeof options.send !== "function") throw new TypeError("native heartbeat send must be a function");
    const intervalMs = options.intervalMs ?? NATIVE_UI_HEARTBEAT_INTERVAL_MS;
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new RangeError("native heartbeat intervalMs must be positive");

    const visible = options.visible ?? (() => typeof document === "undefined" || document.visibilityState === "visible");
    const schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    const cancel = options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    const addLifecycleListener = options.addLifecycleListener ?? defaultLifecycleListener;
    let stopped = false;
    let inFlight = false;
    let pendingVisibility: boolean | null = null;
    let heartbeat = 0;
    let handle: TimerHandle | null = null;
    const reportError = () => {
        try {
            options.onError?.();
        } catch {
            // Diagnostics observers cannot turn a contained heartbeat failure
            // into an unhandled rejection.
        }
    };

    const scheduleNext = () => {
        if (!stopped && handle === null) handle = schedule(tick, intervalMs);
    };
    const send = (nextVisible: boolean) => {
        if (stopped) return;
        if (inFlight) {
            pendingVisibility = nextVisible;
            return;
        }
        let visibilityToSend = nextVisible;
        if (heartbeat >= MAX_NATIVE_UI_HEARTBEAT) {
            // A hidden update deliberately rebases the native page-local
            // sequence, so even a decades-long renderer lifetime cannot get
            // stuck after exhausting u32.
            heartbeat = 0;
            pendingVisibility = nextVisible;
            visibilityToSend = false;
        }
        heartbeat += 1;
        inFlight = true;
        let result: void | PromiseLike<void>;
        try {
            result = options.send(visibilityToSend, heartbeat);
        } catch {
            result = Promise.reject(new Error("native heartbeat send failed"));
        }
        void Promise.resolve(result)
            .catch(reportError)
            .finally(() => {
                inFlight = false;
                if (stopped) return;
                if (pendingVisibility !== null) {
                    const latest = pendingVisibility;
                    pendingVisibility = null;
                    send(latest);
                    return;
                }
                scheduleNext();
            });
    };
    function tick() {
        handle = null;
        send(visible());
    }

    const removeVisibility = addLifecycleListener("visibilitychange", () => send(visible()));
    const removePageShow = addLifecycleListener("pageshow", () => send(visible()));
    const removePageHide = addLifecycleListener("pagehide", () => send(false));
    send(visible());

    return () => {
        if (stopped) return;
        stopped = true;
        if (handle !== null) cancel(handle);
        handle = null;
        pendingVisibility = null;
        removeVisibility();
        removePageShow();
        removePageHide();
    };
}

/**
 * A self-scheduling heartbeat detects main-thread stalls even where WebKit does
 * not expose the Long Tasks API. Background/suspended windows are ignored.
 */
export function startEventLoopMonitor(options: EventLoopMonitorOptions = {}): () => void {
    const intervalMs = options.intervalMs ?? 50;
    const thresholdMs = options.thresholdMs ?? 100;
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new RangeError("intervalMs must be positive");
    if (!Number.isFinite(thresholdMs) || thresholdMs <= 0) throw new RangeError("thresholdMs must be positive");

    const now = options.now ?? (() => performance.now());
    const visible = options.visible ?? (() => typeof document === "undefined" || document.visibilityState === "visible");
    const schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    const cancel = options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    const telemetry = options.telemetry ?? performanceTelemetry;
    let stopped = false;
    let expectedAt = now() + intervalMs;
    let handle: TimerHandle;

    const tick = () => {
        if (stopped) return;
        const current = now();
        const delay = Math.max(0, current - expectedAt);
        telemetry.setGauge("event-loop.last-delay-ms", delay);
        if (visible() && delay >= thresholdMs) {
            telemetry.incrementCounter("event-loop.hangs");
            telemetry.recordLatency(EVENT_LOOP_HANG_METRIC, delay);
        }
        expectedAt = current + intervalMs;
        handle = schedule(tick, intervalMs);
    };

    handle = schedule(tick, intervalMs);
    return () => {
        stopped = true;
        cancel(handle);
    };
}

/** Install payload-free input timing. Event key values and DOM contents are never retained. */
export function installInteractionTiming(): () => void {
    if (typeof window === "undefined") return () => {};
    const recordKeyboard = () => recordNextFrameProxy(INPUT_TO_NEXT_FRAME_METRIC, { source: "keyboard" });
    const recordPointer = () => recordNextFrameProxy(INPUT_TO_NEXT_FRAME_METRIC, { source: "pointer" });
    window.addEventListener("keydown", recordKeyboard, { capture: true });
    window.addEventListener("pointerdown", recordPointer, { capture: true });
    return () => {
        window.removeEventListener("keydown", recordKeyboard, { capture: true });
        window.removeEventListener("pointerdown", recordPointer, { capture: true });
    };
}

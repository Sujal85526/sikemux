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

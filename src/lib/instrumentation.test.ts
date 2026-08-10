import { describe, expect, it, vi } from "vitest";
import { PerformanceTelemetry, performanceTelemetry } from "./performance";
import { ACTION_METRIC, EVENT_LOOP_HANG_METRIC, runMeasuredAction, startEventLoopMonitor, startNativeUiHeartbeat } from "./instrumentation";

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

describe("runMeasuredAction", () => {
    it("preserves return values and errors", () => {
        performanceTelemetry.reset();
        expect(runMeasuredAction("test.action", "test", () => 42)).toBe(42);
        expect(() =>
            runMeasuredAction("test.error", "test", () => {
                throw new Error("boom");
            }),
        ).toThrow("boom");
        expect(performanceTelemetry.snapshot()).toMatchObject({
            latencies: { [ACTION_METRIC]: { count: 2 } },
        });
        expect(performanceTelemetry.snapshot().spans.filter((span) => span.name === ACTION_METRIC)).toHaveLength(2);
    });
});

describe("startEventLoopMonitor", () => {
    it("records visible stalls and ignores background suspension", () => {
        let now = 0;
        let visible = true;
        let scheduled: (() => void) | undefined;
        const telemetry = new PerformanceTelemetry({ now: () => now });
        const stop = startEventLoopMonitor({
            intervalMs: 50,
            thresholdMs: 100,
            now: () => now,
            visible: () => visible,
            telemetry,
            schedule: (callback) => {
                scheduled = callback;
                return 1;
            },
            cancel: vi.fn(),
        });

        now = 175;
        scheduled?.();
        expect(telemetry.snapshot()).toMatchObject({
            counters: { "event-loop.hangs": 1 },
            gauges: { "event-loop.last-delay-ms": 125 },
            latencies: { [EVENT_LOOP_HANG_METRIC]: { count: 1, p95: 125 } },
        });

        visible = false;
        now = 500;
        scheduled?.();
        expect(telemetry.snapshot().counters["event-loop.hangs"]).toBe(1);
        stop();
    });

    it("validates monitor intervals", () => {
        expect(() => startEventLoopMonitor({ intervalMs: 0 })).toThrow(RangeError);
        expect(() => startEventLoopMonitor({ thresholdMs: Number.NaN })).toThrow(RangeError);
    });
});

describe("startNativeUiHeartbeat", () => {
    it("keeps one send in flight and collapses lifecycle changes to the latest visibility", async () => {
        const first = deferred<void>();
        const second = deferred<void>();
        const send = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockResolvedValue(undefined);
        const listeners = new Map<string, () => void>();
        let visible = true;
        let scheduled: (() => void) | undefined;
        const cancel = vi.fn();
        const stop = startNativeUiHeartbeat({
            send,
            visible: () => visible,
            schedule: (callback) => {
                scheduled = callback;
                return 7;
            },
            cancel,
            addLifecycleListener: (event, listener) => {
                listeners.set(event, listener);
                return () => listeners.delete(event);
            },
        });

        expect(send).toHaveBeenCalledWith(true, 1);
        visible = false;
        listeners.get("visibilitychange")?.();
        visible = true;
        listeners.get("pageshow")?.();
        listeners.get("pagehide")?.();
        expect(send).toHaveBeenCalledTimes(1);

        first.resolve();
        await first.promise;
        await Promise.resolve();
        expect(send).toHaveBeenNthCalledWith(2, false, 2);
        expect(scheduled).toBeUndefined();

        second.resolve();
        await second.promise;
        await Promise.resolve();
        expect(scheduled).toBeTypeOf("function");
        scheduled?.();
        expect(send).toHaveBeenNthCalledWith(3, true, 3);

        stop();
        expect(cancel).not.toHaveBeenCalled();
        expect(listeners.size).toBe(0);
    });

    it("contains synchronous and asynchronous send failures before continuing", async () => {
        const onError = vi.fn();
        const scheduled: (() => void)[] = [];
        const send = vi.fn().mockImplementationOnce(() => {
            throw new Error("sync");
        });
        const stop = startNativeUiHeartbeat({
            send,
            onError,
            schedule: (callback) => {
                scheduled.push(callback);
                return scheduled.length;
            },
            addLifecycleListener: () => () => {},
        });

        await Promise.resolve();
        await Promise.resolve();
        expect(onError).toHaveBeenCalledTimes(1);
        expect(scheduled).toHaveLength(1);

        send.mockRejectedValueOnce(new Error("async"));
        scheduled.shift()?.();
        await Promise.resolve();
        await Promise.resolve();
        expect(onError).toHaveBeenCalledTimes(2);
        expect(scheduled).toHaveLength(1);
        stop();
    });
});

describe("metric names", () => {
    it("keeps the public action metric stable", () => {
        expect(ACTION_METRIC).toBe("action.execute");
    });
});

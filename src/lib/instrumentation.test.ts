import { describe, expect, it, vi } from "vitest";
import { PerformanceTelemetry, performanceTelemetry } from "./performance";
import { ACTION_METRIC, EVENT_LOOP_HANG_METRIC, runMeasuredAction, startEventLoopMonitor } from "./instrumentation";

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

describe("metric names", () => {
    it("keeps the public action metric stable", () => {
        expect(ACTION_METRIC).toBe("action.execute");
    });
});

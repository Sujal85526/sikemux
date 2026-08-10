import { describe, expect, it } from "vitest";
import { INPUT_TO_NEXT_FRAME_METRIC, PerformanceTelemetry, type FrameScheduler, type PerformanceMetadata } from "./performance";

describe("PerformanceTelemetry", () => {
    it("records nested spans with monotonic trace IDs in a bounded ring", () => {
        let now = 10;
        const telemetry = new PerformanceTelemetry({ spanCapacity: 2, now: () => now });
        const first = telemetry.startTrace("first", { projectId: "project-1" });
        const child = telemetry.startSpan(first, "child");

        now = 14;
        telemetry.endSpan(child);
        now = 19;
        telemetry.endSpan(first);
        const second = telemetry.startTrace("second");
        now = 23;
        telemetry.endSpan(second);

        const snapshot = telemetry.snapshot();
        expect(first.traceId).toBe(1);
        expect(child.traceId).toBe(first.traceId);
        expect(second.traceId).toBe(2);
        expect(snapshot.spans.map((span) => span.name)).toEqual(["first", "second"]);
        expect(snapshot.spans[0]).toMatchObject({ durationMs: 9, parentSpanId: null });
        expect(snapshot.droppedSpans).toBe(1);
        expect(snapshot.activeSpanCount).toBe(0);
    });

    it("retains scalar metadata while redacting runtime payloads", () => {
        let now = 0;
        const telemetry = new PerformanceTelemetry({ now: () => now });
        const runtimePayload = {
            requestId: "request-1",
            bytes: 42,
            visible: true,
            optional: null,
            nested: { secret: "do-not-retain" },
            oversized: "x".repeat(257),
        } as unknown as PerformanceMetadata;
        const span = telemetry.startTrace("request", runtimePayload);

        now = 5;
        telemetry.endSpan(span, { outcome: "ok" });

        expect(telemetry.snapshot().spans[0].metadata).toEqual({
            requestId: "request-1",
            bytes: 42,
            visible: true,
            optional: null,
            nested: "[redacted]",
            oversized: "[redacted]",
            outcome: "ok",
        });
    });

    it("uses the fixed latency buckets and nearest-rank percentiles", () => {
        const telemetry = new PerformanceTelemetry();
        for (const duration of [0, 3, 4, 7, 8, 15, 16, 32, 33, 99, 100, 101]) {
            telemetry.recordLatency("interaction", duration);
        }

        expect(telemetry.snapshot().latencies.interaction).toEqual({
            count: 12,
            totalCount: 12,
            buckets: {
                "0-4": 2,
                "4-8": 2,
                "8-16": 2,
                "16-33": 2,
                "33-100": 2,
                "100+": 2,
            },
            p50: 15,
            p95: 101,
            p99: 101,
            max: 101,
        });
    });

    it("keeps latency percentiles and buckets to a bounded rolling window", () => {
        const telemetry = new PerformanceTelemetry({ latencySampleCapacity: 3 });
        for (const duration of [1, 5, 9, 120]) telemetry.recordLatency("render", duration);

        expect(telemetry.snapshot().latencies.render).toMatchObject({
            count: 3,
            totalCount: 4,
            buckets: {
                "0-4": 0,
                "4-8": 1,
                "8-16": 1,
                "16-33": 0,
                "33-100": 0,
                "100+": 1,
            },
            p50: 9,
            max: 120,
        });
    });

    it("records input latency only when its caller-provided frame runs", () => {
        let now = 10;
        let onFrame: (() => void) | undefined;
        const scheduleFrame: FrameScheduler = (callback) => {
            onFrame = callback;
        };
        const telemetry = new PerformanceTelemetry({ now: () => now });

        const input = telemetry.recordInputToNextFrame("terminal-key", scheduleFrame, { paneId: "pane-1" });
        expect(telemetry.snapshot()).toMatchObject({ activeSpanCount: 1, spans: [], latencies: {} });

        now = 26;
        onFrame?.();
        onFrame?.();

        const snapshot = telemetry.snapshot();
        expect(input.traceId).toBe(1);
        expect(snapshot.activeSpanCount).toBe(0);
        expect(snapshot.spans).toHaveLength(1);
        expect(snapshot.spans[0]).toMatchObject({
            name: INPUT_TO_NEXT_FRAME_METRIC,
            durationMs: 16,
            metadata: { input: "terminal-key", paneId: "pane-1", outcome: "presented" },
        });
        expect(snapshot.latencies[INPUT_TO_NEXT_FRAME_METRIC]).toMatchObject({
            count: 1,
            buckets: { "16-33": 1 },
            p50: 16,
            p95: 16,
            p99: 16,
            max: 16,
        });
    });

    it("tracks bounded counters and gauges, then resets without reusing IDs", () => {
        let now = 0;
        const telemetry = new PerformanceTelemetry({ metricCapacity: 2, now: () => now });
        const beforeReset = telemetry.startTrace("before-reset");
        telemetry.endSpan(beforeReset);
        expect(telemetry.incrementCounter("pty.output.bytes", 4)).toBe(4);
        expect(telemetry.incrementCounter("pty.output.bytes", 2)).toBe(6);
        telemetry.incrementCounter("terminal.resyncs");
        telemetry.incrementCounter("third.counter");
        telemetry.setGauge("terminal.backlog", 7);

        expect(telemetry.snapshot()).toMatchObject({
            counters: { "terminal.resyncs": 1, "third.counter": 1 },
            gauges: { "terminal.backlog": 7 },
            evictedMetricSeries: 1,
        });

        telemetry.reset();
        now = 1;
        const afterReset = telemetry.startTrace("after-reset");
        telemetry.endSpan(afterReset);

        expect(afterReset.traceId).toBeGreaterThan(beforeReset.traceId);
        expect(telemetry.snapshot()).toMatchObject({
            counters: {},
            gauges: {},
            droppedSpans: 0,
            evictedMetricSeries: 0,
        });
    });
});

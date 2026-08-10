export type PerformanceMetadataValue = string | number | boolean | null;

/**
 * Intentionally excludes objects and arrays so traces cannot accidentally retain
 * request bodies, terminal contents, or other arbitrary application payloads.
 */
export type PerformanceMetadata = Readonly<Record<string, PerformanceMetadataValue>>;

export const INPUT_TO_NEXT_FRAME_METRIC = "input-to-next-frame";

export const LATENCY_BUCKETS = [
    { label: "0-4", upperBoundMs: 4 },
    { label: "4-8", upperBoundMs: 8 },
    { label: "8-16", upperBoundMs: 16 },
    { label: "16-33", upperBoundMs: 33 },
    { label: "33-100", upperBoundMs: 100 },
    { label: "100+", upperBoundMs: Number.POSITIVE_INFINITY },
] as const;

export type LatencyBucketLabel = (typeof LATENCY_BUCKETS)[number]["label"];

export type FrameScheduler = (onFrame: () => void) => void;

export interface PerformanceSpan {
    readonly traceId: number;
    readonly spanId: number;
}

export interface RecordedPerformanceSpan extends PerformanceSpan {
    readonly parentSpanId: number | null;
    readonly name: string;
    readonly startedAt: number;
    readonly endedAt: number;
    readonly durationMs: number;
    readonly metadata: PerformanceMetadata;
}

export interface LatencySummary {
    /** Number of samples retained in the rolling percentile window. */
    readonly count: number;
    /** Number of samples seen since this metric series was created. */
    readonly totalCount: number;
    readonly buckets: Readonly<Record<LatencyBucketLabel, number>>;
    readonly p50: number;
    readonly p95: number;
    readonly p99: number;
    readonly max: number;
}

export interface PerformanceTelemetrySnapshot {
    readonly capturedAt: number;
    readonly spans: readonly RecordedPerformanceSpan[];
    readonly activeSpanCount: number;
    readonly droppedSpans: number;
    readonly evictedMetricSeries: number;
    readonly latencies: Readonly<Record<string, LatencySummary>>;
    readonly counters: Readonly<Record<string, number>>;
    readonly gauges: Readonly<Record<string, number>>;
}

export interface PerformanceTelemetryOptions {
    readonly spanCapacity?: number;
    readonly latencySampleCapacity?: number;
    readonly metricCapacity?: number;
    readonly now?: () => number;
}

type ActiveSpan = {
    readonly traceId: number;
    readonly spanId: number;
    readonly parentSpanId: number | null;
    readonly name: string;
    readonly startedAt: number;
    readonly metadata: PerformanceMetadata;
};

const DEFAULT_SPAN_CAPACITY = 512;
const DEFAULT_LATENCY_SAMPLE_CAPACITY = 512;
const DEFAULT_METRIC_CAPACITY = 128;
const MAX_NAME_LENGTH = 128;
const MAX_METADATA_ENTRIES = 16;
const MAX_METADATA_KEY_LENGTH = 64;
const MAX_METADATA_STRING_LENGTH = 256;
const REDACTED_METADATA_VALUE = "[redacted]";

function defaultClock(): number {
    if (typeof performance !== "undefined" && typeof performance.now === "function") return performance.now();
    return Date.now();
}

function requireCapacity(name: string, value: number): number {
    if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
    return value;
}

function requireName(name: string): string {
    const normalized = name.trim();
    if (!normalized) throw new TypeError("performance metric names cannot be empty");
    if (normalized.length > MAX_NAME_LENGTH) {
        throw new RangeError(`performance metric names cannot exceed ${MAX_NAME_LENGTH} characters`);
    }
    return normalized;
}

function sanitizeMetadata(metadata: PerformanceMetadata): PerformanceMetadata {
    const sanitized: [string, PerformanceMetadataValue][] = [];
    for (const [key, value] of Object.entries(metadata)) {
        if (sanitized.length >= MAX_METADATA_ENTRIES) break;
        if (!key || key.length > MAX_METADATA_KEY_LENGTH) continue;

        if (
            value === null ||
            typeof value === "boolean" ||
            (typeof value === "number" && Number.isFinite(value)) ||
            (typeof value === "string" && value.length <= MAX_METADATA_STRING_LENGTH)
        ) {
            sanitized.push([key, value]);
        } else {
            // Runtime callers may bypass TypeScript. Never retain their payload.
            sanitized.push([key, REDACTED_METADATA_VALUE]);
        }
    }
    return Object.freeze(Object.fromEntries(sanitized));
}

function mergeMetadata(first: PerformanceMetadata, second: PerformanceMetadata): PerformanceMetadata {
    return sanitizeMetadata({ ...first, ...second });
}

function emptyBucketCounts(): Record<LatencyBucketLabel, number> {
    return {
        "0-4": 0,
        "4-8": 0,
        "8-16": 0,
        "16-33": 0,
        "33-100": 0,
        "100+": 0,
    };
}

function latencyBucket(durationMs: number): LatencyBucketLabel {
    for (const bucket of LATENCY_BUCKETS) {
        if (durationMs < bucket.upperBoundMs) return bucket.label;
    }
    return "100+";
}

function percentile(sorted: readonly number[], fraction: number): number {
    const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
    return sorted[index];
}

class RingBuffer<T> {
    private readonly values: (T | undefined)[];
    private start = 0;
    private length = 0;

    constructor(private readonly capacity: number) {
        this.values = new Array<T | undefined>(capacity);
    }

    push(value: T): T | undefined {
        if (this.length < this.capacity) {
            this.values[(this.start + this.length) % this.capacity] = value;
            this.length += 1;
            return undefined;
        }

        const evicted = this.values[this.start];
        this.values[this.start] = value;
        this.start = (this.start + 1) % this.capacity;
        return evicted;
    }

    snapshot(): T[] {
        const result: T[] = [];
        for (let index = 0; index < this.length; index += 1) {
            const value = this.values[(this.start + index) % this.capacity];
            if (value !== undefined) result.push(value);
        }
        return result;
    }

    clear(): void {
        this.values.fill(undefined);
        this.start = 0;
        this.length = 0;
    }
}

class RollingLatency {
    private readonly samples: RingBuffer<number>;
    private readonly buckets = emptyBucketCounts();
    private totalCount = 0;

    constructor(capacity: number) {
        this.samples = new RingBuffer(capacity);
    }

    record(durationMs: number): void {
        const evicted = this.samples.push(durationMs);
        if (evicted !== undefined) this.buckets[latencyBucket(evicted)] -= 1;
        this.buckets[latencyBucket(durationMs)] += 1;
        this.totalCount += 1;
    }

    summary(): LatencySummary {
        const samples = this.samples.snapshot().sort((left, right) => left - right);
        return {
            count: samples.length,
            totalCount: this.totalCount,
            buckets: { ...this.buckets },
            p50: percentile(samples, 0.5),
            p95: percentile(samples, 0.95),
            p99: percentile(samples, 0.99),
            max: samples[samples.length - 1],
        };
    }
}

export class PerformanceTelemetry {
    private readonly now: () => number;
    private readonly latencySampleCapacity: number;
    private readonly metricCapacity: number;
    private readonly spans: RingBuffer<RecordedPerformanceSpan>;
    private activeSpans = new WeakMap<PerformanceSpan, ActiveSpan>();
    private issuedSpans = new WeakSet<PerformanceSpan>();
    private readonly latencies = new Map<string, RollingLatency>();
    private readonly counters = new Map<string, number>();
    private readonly gauges = new Map<string, number>();
    private traceSequence = 0;
    private spanSequence = 0;
    private activeSpanCount = 0;
    private droppedSpans = 0;
    private evictedMetricSeries = 0;

    constructor(options: PerformanceTelemetryOptions = {}) {
        this.now = options.now ?? defaultClock;
        this.latencySampleCapacity = requireCapacity("latencySampleCapacity", options.latencySampleCapacity ?? DEFAULT_LATENCY_SAMPLE_CAPACITY);
        this.metricCapacity = requireCapacity("metricCapacity", options.metricCapacity ?? DEFAULT_METRIC_CAPACITY);
        this.spans = new RingBuffer(requireCapacity("spanCapacity", options.spanCapacity ?? DEFAULT_SPAN_CAPACITY));
    }

    startTrace(name: string, metadata: PerformanceMetadata = {}): PerformanceSpan {
        return this.createSpan(this.nextTraceId(), null, requireName(name), metadata);
    }

    startSpan(parent: PerformanceSpan, name: string, metadata: PerformanceMetadata = {}): PerformanceSpan {
        if (!this.issuedSpans.has(parent)) throw new TypeError("parent span was not created by this telemetry instance");
        return this.createSpan(parent.traceId, parent.spanId, requireName(name), metadata);
    }

    endSpan(span: PerformanceSpan, metadata: PerformanceMetadata = {}): RecordedPerformanceSpan | null {
        const active = this.activeSpans.get(span);
        if (!active) return null;

        this.activeSpans.delete(span);
        this.activeSpanCount -= 1;
        const endedAt = this.readClock();
        const recorded = Object.freeze({
            traceId: active.traceId,
            spanId: active.spanId,
            parentSpanId: active.parentSpanId,
            name: active.name,
            startedAt: active.startedAt,
            endedAt,
            durationMs: Math.max(0, endedAt - active.startedAt),
            metadata: mergeMetadata(active.metadata, metadata),
        });
        if (this.spans.push(recorded) !== undefined) this.droppedSpans += 1;
        return recorded;
    }

    recordLatency(name: string, durationMs: number): void {
        const metricName = requireName(name);
        if (!Number.isFinite(durationMs)) throw new TypeError("latency duration must be finite");
        const normalizedDuration = Math.max(0, durationMs);
        const latency = this.getOrCreateMetric(this.latencies, metricName, () => {
            return new RollingLatency(this.latencySampleCapacity);
        });
        latency.record(normalizedDuration);
    }

    recordInputToNextFrame(input: string, scheduleFrame: FrameScheduler, metadata: PerformanceMetadata = {}): PerformanceSpan {
        const span = this.startTrace(INPUT_TO_NEXT_FRAME_METRIC, mergeMetadata(metadata, { input }));
        try {
            scheduleFrame(() => {
                const recorded = this.endSpan(span, { outcome: "presented" });
                if (recorded) this.recordLatency(INPUT_TO_NEXT_FRAME_METRIC, recorded.durationMs);
            });
        } catch (error) {
            this.endSpan(span, { outcome: "schedule-error" });
            throw error;
        }
        return span;
    }

    incrementCounter(name: string, amount = 1): number {
        const metricName = requireName(name);
        if (!Number.isFinite(amount) || amount < 0) throw new TypeError("counter increments must be non-negative and finite");
        const current = this.getOrCreateMetric(this.counters, metricName, () => 0);
        const next = current + amount;
        this.counters.set(metricName, next);
        return next;
    }

    setGauge(name: string, value: number): void {
        const metricName = requireName(name);
        if (!Number.isFinite(value)) throw new TypeError("gauge values must be finite");
        this.getOrCreateMetric(this.gauges, metricName, () => value);
        this.gauges.set(metricName, value);
    }

    snapshot(): PerformanceTelemetrySnapshot {
        return {
            capturedAt: this.readClock(),
            spans: this.spans.snapshot().map((span) => ({ ...span, metadata: { ...span.metadata } })),
            activeSpanCount: this.activeSpanCount,
            droppedSpans: this.droppedSpans,
            evictedMetricSeries: this.evictedMetricSeries,
            latencies: Object.fromEntries(Array.from(this.latencies, ([name, latency]) => [name, latency.summary()])),
            counters: Object.fromEntries(this.counters),
            gauges: Object.fromEntries(this.gauges),
        };
    }

    reset(): void {
        this.spans.clear();
        this.latencies.clear();
        this.counters.clear();
        this.gauges.clear();
        this.activeSpans = new WeakMap();
        this.issuedSpans = new WeakSet();
        this.activeSpanCount = 0;
        this.droppedSpans = 0;
        this.evictedMetricSeries = 0;
    }

    private createSpan(traceId: number, parentSpanId: number | null, name: string, metadata: PerformanceMetadata): PerformanceSpan {
        const span = Object.freeze({ traceId, spanId: this.nextSpanId() });
        this.issuedSpans.add(span);
        this.activeSpans.set(span, {
            ...span,
            parentSpanId,
            name,
            startedAt: this.readClock(),
            metadata: sanitizeMetadata(metadata),
        });
        this.activeSpanCount += 1;
        return span;
    }

    private nextTraceId(): number {
        if (this.traceSequence >= Number.MAX_SAFE_INTEGER) throw new RangeError("performance trace ID space exhausted");
        this.traceSequence += 1;
        return this.traceSequence;
    }

    private nextSpanId(): number {
        if (this.spanSequence >= Number.MAX_SAFE_INTEGER) throw new RangeError("performance span ID space exhausted");
        this.spanSequence += 1;
        return this.spanSequence;
    }

    private readClock(): number {
        const value = this.now();
        if (!Number.isFinite(value)) throw new TypeError("performance clock must return a finite number");
        return value;
    }

    private getOrCreateMetric<T>(map: Map<string, T>, name: string, create: () => T): T {
        const existing = map.get(name);
        if (existing !== undefined) return existing;

        if (map.size >= this.metricCapacity) {
            const oldest = map.keys().next().value as string | undefined;
            if (oldest !== undefined) {
                map.delete(oldest);
                this.evictedMetricSeries += 1;
            }
        }

        const created = create();
        map.set(name, created);
        return created;
    }
}

export const performanceTelemetry = new PerformanceTelemetry();

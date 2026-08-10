//! Lightweight, bounded process-local observability primitives.
//!
//! This module deliberately does not depend on a logging backend. It keeps a
//! small structured history that can be exposed through diagnostics, while
//! callers may independently forward snapshots to a tracing or telemetry
//! implementation. Values attached to events are scalar-only so diagnostics
//! cannot accidentally retain an arbitrary object graph.

use serde::Serialize;
use std::collections::{BTreeMap, VecDeque};
use std::fmt;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const DEFAULT_EVENT_CAPACITY: usize = 512;
const DEFAULT_LATENCY_SAMPLE_CAPACITY: usize = 512;
const DEFAULT_METRIC_SERIES_CAPACITY: usize = 256;
const DEFAULT_METADATA_ENTRIES: usize = 16;
const DEFAULT_STRING_BYTES: usize = 256;
const DEFAULT_WATCHDOG_SAMPLE_INTERVAL_MS: u64 = 25;
const DEFAULT_WATCHDOG_HANG_THRESHOLD_MS: u64 = 100;
const UI_WATCHDOG_SAMPLE_INTERVAL_MS: u64 = 250;
const UI_WATCHDOG_HANG_THRESHOLD_MS: u64 = 2_000;

static GLOBAL_OBSERVABILITY: OnceLock<Observability> = OnceLock::new();

/// Runtime limits for an [`Observability`] instance.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservabilityConfig {
    pub event_capacity: usize,
    pub latency_sample_capacity: usize,
    pub metric_series_capacity: usize,
    pub max_metadata_entries: usize,
    pub max_string_bytes: usize,
}

impl Default for ObservabilityConfig {
    fn default() -> Self {
        Self {
            event_capacity: DEFAULT_EVENT_CAPACITY,
            latency_sample_capacity: DEFAULT_LATENCY_SAMPLE_CAPACITY,
            metric_series_capacity: DEFAULT_METRIC_SERIES_CAPACITY,
            max_metadata_entries: DEFAULT_METADATA_ENTRIES,
            max_string_bytes: DEFAULT_STRING_BYTES,
        }
    }
}

impl ObservabilityConfig {
    fn normalized(mut self) -> Self {
        self.event_capacity = self.event_capacity.max(1);
        self.latency_sample_capacity = self.latency_sample_capacity.max(1);
        self.metric_series_capacity = self.metric_series_capacity.max(1);
        self.max_metadata_entries = self.max_metadata_entries.max(1);
        self.max_string_bytes = self.max_string_bytes.max(1);
        self
    }
}

/// A trace identifier allocated monotonically for the lifetime of a process.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct TraceId(u64);

impl TraceId {
    pub fn get(self) -> u64 {
        self.0
    }
}

/// A span identifier allocated monotonically for the lifetime of a process.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct SpanId(u64);

impl SpanId {
    pub fn get(self) -> u64 {
        self.0
    }
}

/// Trace linkage that can be propagated across an IPC or task boundary.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpanContext {
    pub trace_id: TraceId,
    pub span_id: SpanId,
}

/// Only scalar metadata is accepted by the event ring.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(untagged)]
pub enum ScalarValue {
    Bool(bool),
    I64(i64),
    U64(u64),
    F64(f64),
    String(String),
}

impl From<bool> for ScalarValue {
    fn from(value: bool) -> Self {
        Self::Bool(value)
    }
}

impl From<i64> for ScalarValue {
    fn from(value: i64) -> Self {
        Self::I64(value)
    }
}

impl From<i32> for ScalarValue {
    fn from(value: i32) -> Self {
        Self::I64(i64::from(value))
    }
}

impl From<u64> for ScalarValue {
    fn from(value: u64) -> Self {
        Self::U64(value)
    }
}

impl From<u32> for ScalarValue {
    fn from(value: u32) -> Self {
        Self::U64(u64::from(value))
    }
}

impl From<usize> for ScalarValue {
    fn from(value: usize) -> Self {
        match u64::try_from(value) {
            Ok(value) => Self::U64(value),
            Err(_) => Self::U64(u64::MAX),
        }
    }
}

impl From<f64> for ScalarValue {
    fn from(value: f64) -> Self {
        Self::F64(value)
    }
}

impl From<String> for ScalarValue {
    fn from(value: String) -> Self {
        Self::String(value)
    }
}

impl From<&str> for ScalarValue {
    fn from(value: &str) -> Self {
        Self::String(value.to_owned())
    }
}

pub type Metadata = BTreeMap<String, ScalarValue>;

/// Terminal state of a timed operation.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SpanOutcome {
    Success,
    Error,
    Cancelled,
    Dropped,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EventKind {
    Event,
    SpanStarted,
    SpanEnded,
    SlowOperation,
}

/// One structured record in the bounded event history.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceEvent {
    pub sequence: u64,
    pub timestamp_us: u64,
    pub trace_id: Option<TraceId>,
    pub span_id: Option<SpanId>,
    pub parent_span_id: Option<SpanId>,
    pub kind: EventKind,
    pub name: String,
    pub outcome: Option<SpanOutcome>,
    pub duration_us: Option<u64>,
    pub metadata: Metadata,
}

/// Counts for the fixed latency buckets. The upper bounds are exclusive.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LatencyBuckets {
    pub under_4_ms: u64,
    pub from_4_to_8_ms: u64,
    pub from_8_to_16_ms: u64,
    pub from_16_to_33_ms: u64,
    pub from_33_to_100_ms: u64,
    pub at_least_100_ms: u64,
}

impl LatencyBuckets {
    fn observe(&mut self, latency_us: u64) {
        match latency_us {
            0..=3_999 => self.under_4_ms = self.under_4_ms.saturating_add(1),
            4_000..=7_999 => self.from_4_to_8_ms = self.from_4_to_8_ms.saturating_add(1),
            8_000..=15_999 => self.from_8_to_16_ms = self.from_8_to_16_ms.saturating_add(1),
            16_000..=32_999 => self.from_16_to_33_ms = self.from_16_to_33_ms.saturating_add(1),
            33_000..=99_999 => self.from_33_to_100_ms = self.from_33_to_100_ms.saturating_add(1),
            _ => self.at_least_100_ms = self.at_least_100_ms.saturating_add(1),
        }
    }
}

/// A bounded-window latency summary.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LatencyHistogramSnapshot {
    pub sample_count: u64,
    pub total_observations: u64,
    pub evicted_samples: u64,
    pub buckets: LatencyBuckets,
    pub p50_us: Option<u64>,
    pub p95_us: Option<u64>,
    pub p99_us: Option<u64>,
    pub max_us: Option<u64>,
}

/// Serializable, point-in-time process observability state.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservabilitySnapshot {
    pub process_uptime_us: u64,
    pub window_duration_us: u64,
    pub events: Vec<TraceEvent>,
    pub dropped_events: u64,
    pub dropped_metric_series: u64,
    pub counters: BTreeMap<String, u64>,
    pub gauges: BTreeMap<String, f64>,
    pub latency_histograms: BTreeMap<String, LatencyHistogramSnapshot>,
}

#[derive(Debug)]
struct LatencySeries {
    samples_us: VecDeque<u64>,
    total_observations: u64,
    evicted_samples: u64,
}

impl LatencySeries {
    fn new() -> Self {
        Self {
            samples_us: VecDeque::new(),
            total_observations: 0,
            evicted_samples: 0,
        }
    }

    fn observe(&mut self, latency_us: u64, capacity: usize) {
        self.total_observations = self.total_observations.saturating_add(1);
        if self.samples_us.len() == capacity {
            self.samples_us.pop_front();
            self.evicted_samples = self.evicted_samples.saturating_add(1);
        }
        self.samples_us.push_back(latency_us);
    }

    fn snapshot(&self) -> LatencyHistogramSnapshot {
        let mut sorted = self.samples_us.iter().copied().collect::<Vec<_>>();
        sorted.sort_unstable();

        let mut buckets = LatencyBuckets::default();
        for latency_us in &sorted {
            buckets.observe(*latency_us);
        }

        LatencyHistogramSnapshot {
            sample_count: usize_to_u64(sorted.len()),
            total_observations: self.total_observations,
            evicted_samples: self.evicted_samples,
            buckets,
            p50_us: percentile(&sorted, 50),
            p95_us: percentile(&sorted, 95),
            p99_us: percentile(&sorted, 99),
            max_us: sorted.last().copied(),
        }
    }
}

#[derive(Debug)]
struct State {
    reset_at_us: u64,
    events: VecDeque<TraceEvent>,
    dropped_events: u64,
    dropped_metric_series: u64,
    counters: BTreeMap<String, u64>,
    gauges: BTreeMap<String, f64>,
    latency_histograms: BTreeMap<String, LatencySeries>,
}

impl State {
    fn new() -> Self {
        Self {
            reset_at_us: 0,
            events: VecDeque::new(),
            dropped_events: 0,
            dropped_metric_series: 0,
            counters: BTreeMap::new(),
            gauges: BTreeMap::new(),
            latency_histograms: BTreeMap::new(),
        }
    }

    fn clear(&mut self, now_us: u64) {
        self.reset_at_us = now_us;
        self.events.clear();
        self.dropped_events = 0;
        self.dropped_metric_series = 0;
        self.counters.clear();
        self.gauges.clear();
        self.latency_histograms.clear();
    }
}

#[derive(Debug)]
struct Inner {
    epoch: Instant,
    next_trace_id: AtomicU64,
    next_span_id: AtomicU64,
    next_sequence: AtomicU64,
    config: ObservabilityConfig,
    state: Mutex<State>,
}

/// Thread-safe, cloneable handle to the process-local observability state.
#[derive(Clone, Debug)]
pub struct Observability {
    inner: Arc<Inner>,
}

impl Default for Observability {
    fn default() -> Self {
        Self::new(ObservabilityConfig::default())
    }
}

/// Returns the lazily initialized process-global observability store.
///
/// The store's epoch begins on first use and remains stable until process
/// exit. Calling [`Observability::reset`] clears samples, not this epoch or the
/// monotonic trace, span, and event ID allocators.
pub fn global_observability() -> &'static Observability {
    GLOBAL_OBSERVABILITY.get_or_init(Observability::default)
}

impl Observability {
    pub fn new(config: ObservabilityConfig) -> Self {
        Self {
            inner: Arc::new(Inner {
                epoch: Instant::now(),
                next_trace_id: AtomicU64::new(1),
                next_span_id: AtomicU64::new(1),
                next_sequence: AtomicU64::new(1),
                config: config.normalized(),
                state: Mutex::new(State::new()),
            }),
        }
    }

    /// Allocates a trace ID. IDs are never reset with the sampled state.
    pub fn next_trace_id(&self) -> TraceId {
        TraceId(next_monotonic_id(&self.inner.next_trace_id))
    }

    /// Starts a root span, or a child span when `parent` is supplied.
    #[must_use = "dropping the guard records a dropped span"]
    pub fn begin_span(
        &self,
        name: impl Into<String>,
        parent: Option<SpanContext>,
        metadata: Metadata,
    ) -> SpanGuard {
        let trace_id = parent
            .map(|context| context.trace_id)
            .unwrap_or_else(|| self.next_trace_id());
        let parent_span_id = parent.map(|context| context.span_id);
        self.begin_span_in_trace(trace_id, parent_span_id, name, metadata)
    }

    /// Starts a span in an existing trace, optionally beneath another span.
    #[must_use = "dropping the guard records a dropped span"]
    pub fn begin_span_in_trace(
        &self,
        trace_id: TraceId,
        parent_span_id: Option<SpanId>,
        name: impl Into<String>,
        metadata: Metadata,
    ) -> SpanGuard {
        let span_id = SpanId(next_monotonic_id(&self.inner.next_span_id));
        let name = self.sanitize_text(name.into());
        let started_at = Instant::now();
        let context = SpanContext { trace_id, span_id };

        self.push_event(TraceEvent {
            sequence: self.next_sequence(),
            timestamp_us: self.now_us(),
            trace_id: Some(trace_id),
            span_id: Some(span_id),
            parent_span_id,
            kind: EventKind::SpanStarted,
            name: name.clone(),
            outcome: None,
            duration_us: None,
            metadata: self.sanitize_metadata(metadata),
        });

        SpanGuard {
            observer: self.clone(),
            context,
            parent_span_id,
            name,
            started_at,
            completed: false,
        }
    }

    /// Records an instantaneous event and returns its monotonic sequence.
    pub fn record_event(
        &self,
        name: impl Into<String>,
        context: Option<SpanContext>,
        metadata: Metadata,
    ) -> u64 {
        let sequence = self.next_sequence();
        self.push_event(TraceEvent {
            sequence,
            timestamp_us: self.now_us(),
            trace_id: context.map(|value| value.trace_id),
            span_id: context.map(|value| value.span_id),
            parent_span_id: None,
            kind: EventKind::Event,
            name: self.sanitize_text(name.into()),
            outcome: None,
            duration_us: None,
            metadata: self.sanitize_metadata(metadata),
        });
        sequence
    }

    /// Increments a named counter, saturating at `u64::MAX`.
    ///
    /// Returns `None` when the configured metric-series limit rejects a new
    /// name. Existing names continue to be updated at the limit.
    pub fn increment_counter(&self, name: impl Into<String>, delta: u64) -> Option<u64> {
        let name = self.sanitize_text(name.into());
        let mut state = self.lock_state();
        if !state.counters.contains_key(&name)
            && self.metric_series_count(&state) >= self.inner.config.metric_series_capacity
        {
            state.dropped_metric_series = state.dropped_metric_series.saturating_add(1);
            return None;
        }

        let counter = state.counters.entry(name).or_insert(0);
        *counter = counter.saturating_add(delta);
        Some(*counter)
    }

    /// Sets a finite gauge value.
    ///
    /// Non-finite values and new names above the metric-series limit are
    /// rejected because they cannot be represented reliably in JSON.
    pub fn set_gauge(&self, name: impl Into<String>, value: f64) -> bool {
        if !value.is_finite() {
            return false;
        }

        let name = self.sanitize_text(name.into());
        let mut state = self.lock_state();
        if !state.gauges.contains_key(&name)
            && self.metric_series_count(&state) >= self.inner.config.metric_series_capacity
        {
            state.dropped_metric_series = state.dropped_metric_series.saturating_add(1);
            return false;
        }
        state.gauges.insert(name, value);
        true
    }

    /// Adds a duration to a named bounded-window latency histogram.
    pub fn observe_latency(&self, name: impl Into<String>, latency: Duration) -> bool {
        self.observe_latency_us(name.into(), duration_us(latency))
    }

    /// Creates a timer which records every duration in a latency histogram and
    /// emits a structured event only when it meets the supplied threshold.
    #[must_use = "dropping the guard records a dropped operation outcome"]
    pub fn slow_operation(
        &self,
        name: impl Into<String>,
        threshold: Duration,
        parent: Option<SpanContext>,
        metadata: Metadata,
    ) -> SlowOperationGuard {
        let trace_id = parent
            .map(|context| context.trace_id)
            .unwrap_or_else(|| self.next_trace_id());
        let parent_span_id = parent.map(|context| context.span_id);
        let span_id = SpanId(next_monotonic_id(&self.inner.next_span_id));

        SlowOperationGuard {
            observer: self.clone(),
            context: SpanContext { trace_id, span_id },
            parent_span_id,
            name: self.sanitize_text(name.into()),
            threshold_us: duration_us(threshold),
            metadata: self.sanitize_metadata(metadata),
            started_at: Instant::now(),
            completed: false,
        }
    }

    /// Returns a consistent snapshot while retaining the current window.
    pub fn snapshot(&self) -> ObservabilitySnapshot {
        let now_us = self.now_us();
        let state = self.lock_state();
        self.snapshot_locked(&state, now_us)
    }

    /// Atomically returns the current snapshot and starts a fresh sample window.
    /// Trace, span, and event sequence IDs intentionally remain monotonic.
    pub fn reset(&self) -> ObservabilitySnapshot {
        let now_us = self.now_us();
        let mut state = self.lock_state();
        let snapshot = self.snapshot_locked(&state, now_us);
        state.clear(now_us);
        snapshot
    }

    fn finish_span(
        &self,
        context: SpanContext,
        parent_span_id: Option<SpanId>,
        name: String,
        started_at: Instant,
        outcome: SpanOutcome,
        metadata: Metadata,
    ) -> u64 {
        let elapsed_us = duration_us(started_at.elapsed());
        self.push_event(TraceEvent {
            sequence: self.next_sequence(),
            timestamp_us: self.now_us(),
            trace_id: Some(context.trace_id),
            span_id: Some(context.span_id),
            parent_span_id,
            kind: EventKind::SpanEnded,
            name,
            outcome: Some(outcome),
            duration_us: Some(elapsed_us),
            metadata: self.sanitize_metadata(metadata),
        });
        elapsed_us
    }

    fn finish_slow_operation(&self, guard: &SlowOperationGuard, outcome: SpanOutcome) -> u64 {
        let elapsed_us = duration_us(guard.started_at.elapsed());
        self.observe_latency_us(guard.name.clone(), elapsed_us);

        if elapsed_us >= guard.threshold_us {
            let mut metadata = guard.metadata.clone();
            metadata.insert(
                "threshold_us".to_owned(),
                ScalarValue::U64(guard.threshold_us),
            );
            self.push_event(TraceEvent {
                sequence: self.next_sequence(),
                timestamp_us: self.now_us(),
                trace_id: Some(guard.context.trace_id),
                span_id: Some(guard.context.span_id),
                parent_span_id: guard.parent_span_id,
                kind: EventKind::SlowOperation,
                name: guard.name.clone(),
                outcome: Some(outcome),
                duration_us: Some(elapsed_us),
                metadata: self.sanitize_metadata(metadata),
            });
        }

        elapsed_us
    }

    fn observe_latency_us(&self, name: String, latency_us: u64) -> bool {
        let name = self.sanitize_text(name);
        let mut state = self.lock_state();
        if !state.latency_histograms.contains_key(&name)
            && self.metric_series_count(&state) >= self.inner.config.metric_series_capacity
        {
            state.dropped_metric_series = state.dropped_metric_series.saturating_add(1);
            return false;
        }

        let histogram = state
            .latency_histograms
            .entry(name)
            .or_insert_with(LatencySeries::new);
        histogram.observe(latency_us, self.inner.config.latency_sample_capacity);
        true
    }

    fn push_event(&self, event: TraceEvent) {
        let mut state = self.lock_state();
        if state.events.len() == self.inner.config.event_capacity {
            state.events.pop_front();
            state.dropped_events = state.dropped_events.saturating_add(1);
        }
        state.events.push_back(event);
    }

    fn snapshot_locked(&self, state: &State, now_us: u64) -> ObservabilitySnapshot {
        let latency_histograms = state
            .latency_histograms
            .iter()
            .map(|(name, histogram)| (name.clone(), histogram.snapshot()))
            .collect();

        ObservabilitySnapshot {
            process_uptime_us: now_us,
            window_duration_us: now_us.saturating_sub(state.reset_at_us),
            events: state.events.iter().cloned().collect(),
            dropped_events: state.dropped_events,
            dropped_metric_series: state.dropped_metric_series,
            counters: state.counters.clone(),
            gauges: state.gauges.clone(),
            latency_histograms,
        }
    }

    fn metric_series_count(&self, state: &State) -> usize {
        state
            .counters
            .len()
            .saturating_add(state.gauges.len())
            .saturating_add(state.latency_histograms.len())
    }

    fn next_sequence(&self) -> u64 {
        next_monotonic_id(&self.inner.next_sequence)
    }

    fn now_us(&self) -> u64 {
        duration_us(self.inner.epoch.elapsed())
    }

    fn lock_state(&self) -> MutexGuard<'_, State> {
        match self.inner.state.lock() {
            Ok(state) => state,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    fn sanitize_metadata(&self, metadata: Metadata) -> Metadata {
        metadata
            .into_iter()
            .take(self.inner.config.max_metadata_entries)
            .map(|(key, value)| {
                let key = self.sanitize_text(key);
                let value = match value {
                    ScalarValue::String(value) => ScalarValue::String(self.sanitize_text(value)),
                    ScalarValue::F64(value) if !value.is_finite() => {
                        ScalarValue::String("non-finite".to_owned())
                    }
                    value => value,
                };
                (key, value)
            })
            .collect()
    }

    fn sanitize_text(&self, mut value: String) -> String {
        let max_bytes = self.inner.config.max_string_bytes;
        if value.len() <= max_bytes {
            return value;
        }

        let mut boundary = max_bytes;
        while boundary > 0 && !value.is_char_boundary(boundary) {
            boundary -= 1;
        }
        value.truncate(boundary);
        value
    }
}

/// RAII timer for a structured span.
#[must_use = "dropping the guard records a dropped span"]
pub struct SpanGuard {
    observer: Observability,
    context: SpanContext,
    parent_span_id: Option<SpanId>,
    name: String,
    started_at: Instant,
    completed: bool,
}

impl SpanGuard {
    pub fn context(&self) -> SpanContext {
        self.context
    }

    /// Ends the span with an explicit outcome and no end metadata.
    pub fn finish(self, outcome: SpanOutcome) -> u64 {
        self.finish_with_metadata(outcome, Metadata::new())
    }

    /// Ends the span with an explicit outcome and scalar end metadata.
    pub fn finish_with_metadata(mut self, outcome: SpanOutcome, metadata: Metadata) -> u64 {
        self.completed = true;
        self.observer.finish_span(
            self.context,
            self.parent_span_id,
            self.name.clone(),
            self.started_at,
            outcome,
            metadata,
        )
    }
}

impl Drop for SpanGuard {
    fn drop(&mut self) {
        if !self.completed {
            self.completed = true;
            self.observer.finish_span(
                self.context,
                self.parent_span_id,
                self.name.clone(),
                self.started_at,
                SpanOutcome::Dropped,
                Metadata::new(),
            );
        }
    }
}

/// RAII timer which reports only operations at or above a slow threshold.
/// Every elapsed duration is still retained in the named latency histogram.
#[must_use = "dropping the guard records a dropped operation outcome"]
pub struct SlowOperationGuard {
    observer: Observability,
    context: SpanContext,
    parent_span_id: Option<SpanId>,
    name: String,
    threshold_us: u64,
    metadata: Metadata,
    started_at: Instant,
    completed: bool,
}

impl SlowOperationGuard {
    pub fn context(&self) -> SpanContext {
        self.context
    }

    /// Completes the timer with an explicit outcome.
    pub fn finish(mut self, outcome: SpanOutcome) -> u64 {
        self.completed = true;
        self.observer.finish_slow_operation(&self, outcome)
    }
}

impl Drop for SlowOperationGuard {
    fn drop(&mut self) {
        if !self.completed {
            self.completed = true;
            self.observer
                .finish_slow_operation(self, SpanOutcome::Dropped);
        }
    }
}

/// Snapshot of a heartbeat shared with a watchdog thread.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatSnapshot {
    pub sequence: u64,
    pub last_beat_us: u64,
    pub armed: bool,
    pub visible: bool,
}

#[derive(Debug)]
struct HeartbeatInner {
    sequence: AtomicU64,
    last_beat_us: AtomicU64,
    armed: AtomicBool,
    visible: AtomicBool,
}

/// A cheap, monotonic heartbeat that may be updated from any thread.
///
/// UI code should call [`Heartbeat::beat`] after it proves forward progress,
/// for example after handling an input or presenting a frame. Arming and
/// visibility are separate so expected startup work or a hidden window does
/// not produce a false hang report.
#[derive(Clone, Debug)]
pub struct Heartbeat {
    inner: Arc<HeartbeatInner>,
}

impl Default for Heartbeat {
    fn default() -> Self {
        Self::new()
    }
}

impl Heartbeat {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(HeartbeatInner {
                sequence: AtomicU64::new(0),
                last_beat_us: AtomicU64::new(global_observability().now_us()),
                armed: AtomicBool::new(true),
                visible: AtomicBool::new(true),
            }),
        }
    }

    /// Marks forward progress and returns the new monotonic heartbeat number.
    pub fn beat(&self) -> u64 {
        let now_us = global_observability().now_us();
        // Multiple producers may race. `fetch_max` prevents an older producer
        // from moving the observed heartbeat timestamp backwards.
        self.inner.last_beat_us.fetch_max(now_us, Ordering::Release);
        increment_monotonic(&self.inner.sequence)
    }

    pub fn set_armed(&self, armed: bool) {
        if armed {
            // Re-arming starts a fresh deadline instead of immediately
            // reporting time intentionally spent disarmed as a hang.
            self.inner
                .last_beat_us
                .fetch_max(global_observability().now_us(), Ordering::Release);
        }
        self.inner.armed.store(armed, Ordering::Release);
    }

    pub fn set_visible(&self, visible: bool) {
        if visible {
            // Likewise, returning from a hidden state starts a fresh deadline.
            self.inner
                .last_beat_us
                .fetch_max(global_observability().now_us(), Ordering::Release);
        }
        self.inner.visible.store(visible, Ordering::Release);
    }

    pub fn snapshot(&self) -> HeartbeatSnapshot {
        HeartbeatSnapshot {
            sequence: self.inner.sequence.load(Ordering::Acquire),
            last_beat_us: self.inner.last_beat_us.load(Ordering::Acquire),
            armed: self.inner.armed.load(Ordering::Acquire),
            visible: self.inner.visible.load(Ordering::Acquire),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct UiHeartbeatProgress {
    active: bool,
    last_sequence: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum UiHeartbeatTransition {
    Suspended,
    Activated,
    Advanced,
    Unchanged,
}

fn classify_ui_heartbeat_update(
    progress: &mut UiHeartbeatProgress,
    visible: bool,
    sequence: u32,
) -> UiHeartbeatTransition {
    if !visible {
        progress.active = false;
        progress.last_sequence = sequence;
        return UiHeartbeatTransition::Suspended;
    }

    if !progress.active {
        progress.active = true;
        progress.last_sequence = sequence;
        return UiHeartbeatTransition::Activated;
    }

    if sequence > progress.last_sequence {
        progress.last_sequence = sequence;
        UiHeartbeatTransition::Advanced
    } else {
        UiHeartbeatTransition::Unchanged
    }
}

fn inactive_ui_heartbeat() -> Heartbeat {
    let heartbeat = Heartbeat::new();
    heartbeat.set_armed(false);
    heartbeat.set_visible(false);
    heartbeat
}

fn apply_ui_heartbeat_update(
    heartbeat: &Heartbeat,
    progress: &mut UiHeartbeatProgress,
    visible: bool,
    sequence: u32,
) -> UiHeartbeatTransition {
    let transition = classify_ui_heartbeat_update(progress, visible, sequence);
    match transition {
        UiHeartbeatTransition::Suspended => {
            heartbeat.set_armed(false);
            heartbeat.set_visible(false);
        }
        UiHeartbeatTransition::Activated => {
            // Returning from startup, a hidden window, or a page reload starts
            // with a fresh deadline and accepts the new page's sequence base.
            heartbeat.set_visible(true);
            heartbeat.beat();
            heartbeat.set_armed(true);
        }
        UiHeartbeatTransition::Advanced => {
            heartbeat.beat();
        }
        UiHeartbeatTransition::Unchanged => {}
    }
    transition
}

/// Tauri-managed owner of the process UI heartbeat and watchdog thread.
///
/// The watchdog starts inactive. A visible heartbeat update establishes its
/// first deadline; hiding or reloading the page suspends it. Keeping ownership
/// here guarantees that application-state teardown stops and joins the thread.
pub struct UiWatchdogState {
    heartbeat: Heartbeat,
    progress: Mutex<UiHeartbeatProgress>,
    watchdog: Option<HangWatchdogHandle>,
}

impl UiWatchdogState {
    pub(crate) fn start() -> std::io::Result<Self> {
        let heartbeat = inactive_ui_heartbeat();
        let watchdog = start_hang_watchdog(
            heartbeat.clone(),
            HangWatchdogConfig {
                name: "ui".to_owned(),
                sample_interval_ms: UI_WATCHDOG_SAMPLE_INTERVAL_MS,
                hang_threshold_ms: UI_WATCHDOG_HANG_THRESHOLD_MS,
                monitor_hidden: false,
            },
        )?;
        Ok(Self {
            heartbeat,
            progress: Mutex::new(UiHeartbeatProgress::default()),
            watchdog: Some(watchdog),
        })
    }

    pub(crate) fn suspend(&self) {
        let mut progress = self.lock_progress();
        let sequence = progress.last_sequence;
        apply_ui_heartbeat_update(&self.heartbeat, &mut progress, false, sequence);
    }

    fn update(&self, visible: bool, sequence: u32) {
        let mut progress = self.lock_progress();
        apply_ui_heartbeat_update(&self.heartbeat, &mut progress, visible, sequence);
    }

    fn lock_progress(&self) -> MutexGuard<'_, UiHeartbeatProgress> {
        match self.progress.lock() {
            Ok(progress) => progress,
            Err(poisoned) => poisoned.into_inner(),
        }
    }
}

impl Drop for UiWatchdogState {
    fn drop(&mut self) {
        if let Some(watchdog) = self.watchdog.take() {
            let _ = watchdog.stop();
        }
    }
}

/// Updates the managed UI watchdog using bounded scalar-only input.
///
/// `heartbeat` is a page-local monotonically increasing sequence. Duplicate or
/// regressed values do not refresh the deadline. A hidden update disarms the
/// watchdog, and the next visible update establishes a new sequence baseline.
#[tauri::command]
pub fn observability_ui_heartbeat(
    state: tauri::State<'_, UiWatchdogState>,
    visible: bool,
    heartbeat: u32,
) {
    state.update(visible, heartbeat);
}

/// Sampling policy for the process hang watchdog.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HangWatchdogConfig {
    /// Low-cardinality label used in metric names and event metadata.
    pub name: String,
    /// Delay between samples. Zero is normalized to one millisecond.
    pub sample_interval_ms: u64,
    /// A delay equal to or greater than this value is a hang.
    pub hang_threshold_ms: u64,
    /// When false, an invisible heartbeat is treated as intentionally idle.
    pub monitor_hidden: bool,
}

impl Default for HangWatchdogConfig {
    fn default() -> Self {
        Self {
            name: "ui".to_owned(),
            sample_interval_ms: DEFAULT_WATCHDOG_SAMPLE_INTERVAL_MS,
            hang_threshold_ms: DEFAULT_WATCHDOG_HANG_THRESHOLD_MS,
            monitor_hidden: false,
        }
    }
}

impl HangWatchdogConfig {
    fn normalized(mut self, observer: &Observability) -> Self {
        self.name = observer.sanitize_text(self.name);
        if self.name.is_empty() {
            self.name = "ui".to_owned();
        }
        self.sample_interval_ms = self.sample_interval_ms.max(1);
        self.hang_threshold_ms = self.hang_threshold_ms.max(1);
        self
    }
}

/// Result of classifying one watchdog sample.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HeartbeatDelayClassification {
    Inactive,
    Healthy,
    HangStarted,
    HangOngoing,
    Recovered,
}

/// Pure watchdog state transition used by the production sampler and tests.
pub fn classify_heartbeat_delay(
    delay: Duration,
    threshold: Duration,
    previously_hung: bool,
    monitored: bool,
) -> HeartbeatDelayClassification {
    if !monitored {
        return HeartbeatDelayClassification::Inactive;
    }

    if delay >= threshold {
        if previously_hung {
            HeartbeatDelayClassification::HangOngoing
        } else {
            HeartbeatDelayClassification::HangStarted
        }
    } else if previously_hung {
        HeartbeatDelayClassification::Recovered
    } else {
        HeartbeatDelayClassification::Healthy
    }
}

#[derive(Debug)]
struct WatchdogSignal {
    stopped: Mutex<bool>,
    wake: Condvar,
}

impl WatchdogSignal {
    fn new() -> Self {
        Self {
            stopped: Mutex::new(false),
            wake: Condvar::new(),
        }
    }

    fn stop(&self) {
        {
            let mut stopped = self.lock_stopped();
            *stopped = true;
        }
        self.wake.notify_all();
    }

    fn is_stopped(&self) -> bool {
        *self.lock_stopped()
    }

    /// Returns true when stopped. The predicate closes the notify-before-wait
    /// race, allowing shutdown to interrupt even a very long sample interval.
    fn wait_until_stopped(&self, timeout: Duration) -> bool {
        let stopped = self.lock_stopped();
        if *stopped {
            return true;
        }

        let stopped = match self
            .wake
            .wait_timeout_while(stopped, timeout, |stopped| !*stopped)
        {
            Ok((stopped, _)) => stopped,
            Err(poisoned) => poisoned.into_inner().0,
        };
        *stopped
    }

    fn lock_stopped(&self) -> MutexGuard<'_, bool> {
        match self.stopped.lock() {
            Ok(stopped) => stopped,
            Err(poisoned) => poisoned.into_inner(),
        }
    }
}

#[derive(Debug)]
struct WatchdogMetricNames {
    samples: String,
    hangs: String,
    recoveries: String,
    delay_gauge: String,
    delay_histogram: String,
}

impl WatchdogMetricNames {
    fn new(name: &str) -> Self {
        let prefix = format!("watchdog.{name}");
        Self {
            samples: format!("{prefix}.samples"),
            hangs: format!("{prefix}.hangs"),
            recoveries: format!("{prefix}.recoveries"),
            delay_gauge: format!("{prefix}.heartbeat_delay_us"),
            delay_histogram: format!("{prefix}.heartbeat_delay"),
        }
    }
}

/// Error returned when the dedicated watchdog OS thread panics.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct WatchdogJoinError;

impl fmt::Display for WatchdogJoinError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("hang watchdog thread panicked")
    }
}

impl std::error::Error for WatchdogJoinError {}

/// Owner of a running watchdog thread.
///
/// Calling [`HangWatchdogHandle::stop`] interrupts its condition-variable wait
/// and joins it. Dropping the handle provides the same clean shutdown fallback.
#[must_use = "dropping the handle immediately stops the watchdog"]
pub struct HangWatchdogHandle {
    signal: Arc<WatchdogSignal>,
    thread: Option<JoinHandle<()>>,
}

impl HangWatchdogHandle {
    pub fn is_finished(&self) -> bool {
        self.thread
            .as_ref()
            .map(JoinHandle::is_finished)
            .unwrap_or(true)
    }

    pub fn stop(mut self) -> Result<(), WatchdogJoinError> {
        self.signal.stop();
        self.join()
    }

    fn join(&mut self) -> Result<(), WatchdogJoinError> {
        match self.thread.take() {
            Some(thread) => thread.join().map_err(|_| WatchdogJoinError),
            None => Ok(()),
        }
    }
}

impl Drop for HangWatchdogHandle {
    fn drop(&mut self) {
        self.signal.stop();
        // Drop cannot surface a panic. Explicit `stop` remains available when
        // the caller wants to distinguish a clean join from a panicked thread.
        let _ = self.join();
    }
}

/// Starts a dedicated OS thread which samples `heartbeat` and writes bounded
/// diagnostics to [`global_observability`].
pub fn start_hang_watchdog(
    heartbeat: Heartbeat,
    config: HangWatchdogConfig,
) -> std::io::Result<HangWatchdogHandle> {
    let observer = global_observability();
    let config = config.normalized(observer);
    let signal = Arc::new(WatchdogSignal::new());
    let thread_signal = signal.clone();
    let thread = thread::Builder::new()
        .name("sikemux-hang-watchdog".to_owned())
        .spawn(move || run_watchdog(heartbeat, config, thread_signal))?;

    Ok(HangWatchdogHandle {
        signal,
        thread: Some(thread),
    })
}

fn run_watchdog(heartbeat: Heartbeat, config: HangWatchdogConfig, signal: Arc<WatchdogSignal>) {
    let observer = global_observability();
    let metric_names = WatchdogMetricNames::new(&config.name);
    let sample_interval = Duration::from_millis(config.sample_interval_ms);
    let threshold = Duration::from_millis(config.hang_threshold_ms);
    let mut previously_hung = false;

    while !signal.is_stopped() {
        let heartbeat_snapshot = heartbeat.snapshot();
        let now_us = observer.now_us();
        let delay_us = now_us.saturating_sub(heartbeat_snapshot.last_beat_us);
        let monitored =
            heartbeat_snapshot.armed && (config.monitor_hidden || heartbeat_snapshot.visible);
        let classification = classify_heartbeat_delay(
            Duration::from_micros(delay_us),
            threshold,
            previously_hung,
            monitored,
        );

        record_watchdog_sample(
            observer,
            &config,
            &metric_names,
            heartbeat_snapshot,
            delay_us,
            classification,
        );
        previously_hung = matches!(
            classification,
            HeartbeatDelayClassification::HangStarted | HeartbeatDelayClassification::HangOngoing
        );

        if signal.wait_until_stopped(sample_interval) {
            break;
        }
    }
}

fn record_watchdog_sample(
    observer: &Observability,
    config: &HangWatchdogConfig,
    metric_names: &WatchdogMetricNames,
    heartbeat: HeartbeatSnapshot,
    delay_us: u64,
    classification: HeartbeatDelayClassification,
) {
    if classification == HeartbeatDelayClassification::Inactive {
        return;
    }

    let _ = observer.increment_counter(metric_names.samples.clone(), 1);
    observer.set_gauge(metric_names.delay_gauge.clone(), delay_us as f64);
    observer.observe_latency(
        metric_names.delay_histogram.clone(),
        Duration::from_micros(delay_us),
    );

    let (event_name, counter_name) = match classification {
        HeartbeatDelayClassification::HangStarted => {
            (Some("watchdog.hang_started"), Some(&metric_names.hangs))
        }
        HeartbeatDelayClassification::Recovered => (
            Some("watchdog.hang_recovered"),
            Some(&metric_names.recoveries),
        ),
        HeartbeatDelayClassification::Inactive
        | HeartbeatDelayClassification::Healthy
        | HeartbeatDelayClassification::HangOngoing => (None, None),
    };

    if let Some(counter_name) = counter_name {
        let _ = observer.increment_counter(counter_name.clone(), 1);
    }
    if let Some(event_name) = event_name {
        let mut metadata = Metadata::new();
        metadata.insert(
            "watchdog".to_owned(),
            ScalarValue::String(config.name.clone()),
        );
        metadata.insert("delay_us".to_owned(), ScalarValue::U64(delay_us));
        metadata.insert(
            "threshold_us".to_owned(),
            ScalarValue::U64(config.hang_threshold_ms.saturating_mul(1_000)),
        );
        metadata.insert(
            "heartbeat_sequence".to_owned(),
            ScalarValue::U64(heartbeat.sequence),
        );
        metadata.insert("visible".to_owned(), ScalarValue::Bool(heartbeat.visible));
        observer.record_event(event_name, None, metadata);
    }
}

fn duration_us(duration: Duration) -> u64 {
    u64::try_from(duration.as_micros()).unwrap_or(u64::MAX)
}

fn next_monotonic_id(counter: &AtomicU64) -> u64 {
    loop {
        let current = counter.load(Ordering::Relaxed);
        let next = match current.checked_add(1) {
            Some(next) => next,
            // Exhausting a 64-bit process-local ID space is not recoverable:
            // wrapping would make traces ambiguous and violate the API.
            None => std::process::abort(),
        };
        if counter
            .compare_exchange_weak(current, next, Ordering::Relaxed, Ordering::Relaxed)
            .is_ok()
        {
            return current;
        }
    }
}

fn increment_monotonic(counter: &AtomicU64) -> u64 {
    loop {
        let current = counter.load(Ordering::Relaxed);
        let next = match current.checked_add(1) {
            Some(next) => next,
            None => std::process::abort(),
        };
        if counter
            .compare_exchange_weak(current, next, Ordering::Release, Ordering::Relaxed)
            .is_ok()
        {
            return next;
        }
    }
}

fn usize_to_u64(value: usize) -> u64 {
    u64::try_from(value).unwrap_or(u64::MAX)
}

fn percentile(sorted: &[u64], percentile: u128) -> Option<u64> {
    if sorted.is_empty() {
        return None;
    }

    let length = sorted.len() as u128;
    let rank = length
        .saturating_mul(percentile)
        .saturating_add(99)
        .saturating_div(100)
        .saturating_sub(1);
    match usize::try_from(rank) {
        Ok(index) => sorted.get(index).copied(),
        Err(_) => sorted.last().copied(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(event_capacity: usize, latency_sample_capacity: usize) -> ObservabilityConfig {
        ObservabilityConfig {
            event_capacity,
            latency_sample_capacity,
            metric_series_capacity: 16,
            max_metadata_entries: 4,
            max_string_bytes: 16,
        }
    }

    #[test]
    fn event_history_is_bounded_and_ordered() {
        let observer = Observability::new(config(2, 8));
        observer.record_event("one", None, Metadata::new());
        observer.record_event("two", None, Metadata::new());
        observer.record_event("three", None, Metadata::new());

        let snapshot = observer.snapshot();
        assert_eq!(snapshot.events.len(), 2);
        assert_eq!(snapshot.dropped_events, 1);
        assert_eq!(snapshot.events[0].name, "two");
        assert_eq!(snapshot.events[1].name, "three");
        assert!(snapshot.events[0].sequence < snapshot.events[1].sequence);
    }

    #[test]
    fn trace_and_span_ids_are_monotonic_and_linked() {
        let observer = Observability::default();
        let root = observer.begin_span("root", None, Metadata::new());
        let root_context = root.context();
        let child = observer.begin_span("child", Some(root_context), Metadata::new());
        let child_context = child.context();

        assert!(child_context.span_id > root_context.span_id);
        assert_eq!(child_context.trace_id, root_context.trace_id);
        child.finish(SpanOutcome::Success);
        root.finish(SpanOutcome::Success);

        let starts = observer
            .snapshot()
            .events
            .into_iter()
            .filter(|event| event.kind == EventKind::SpanStarted)
            .collect::<Vec<_>>();
        assert_eq!(starts[1].parent_span_id, Some(root_context.span_id));
    }

    #[test]
    fn span_guard_records_explicit_and_drop_outcomes() {
        let observer = Observability::default();
        observer
            .begin_span("explicit", None, Metadata::new())
            .finish(SpanOutcome::Error);
        {
            let _dropped = observer.begin_span("dropped", None, Metadata::new());
        }

        let endings = observer
            .snapshot()
            .events
            .into_iter()
            .filter(|event| event.kind == EventKind::SpanEnded)
            .collect::<Vec<_>>();
        assert_eq!(endings.len(), 2);
        assert_eq!(endings[0].outcome, Some(SpanOutcome::Error));
        assert_eq!(endings[1].outcome, Some(SpanOutcome::Dropped));
        assert!(endings.iter().all(|event| event.duration_us.is_some()));
    }

    #[test]
    fn histogram_uses_fixed_buckets_and_nearest_rank_percentiles() {
        let observer = Observability::new(config(8, 16));
        for latency_us in [
            0, 3_999, 4_000, 7_999, 8_000, 15_999, 16_000, 32_999, 33_000, 99_999, 100_000,
        ] {
            assert!(observer.observe_latency_us("input".to_owned(), latency_us));
        }

        let snapshot = observer.snapshot();
        let histogram = snapshot.latency_histograms.get("input").unwrap();
        assert_eq!(histogram.sample_count, 11);
        assert_eq!(histogram.buckets.under_4_ms, 2);
        assert_eq!(histogram.buckets.from_4_to_8_ms, 2);
        assert_eq!(histogram.buckets.from_8_to_16_ms, 2);
        assert_eq!(histogram.buckets.from_16_to_33_ms, 2);
        assert_eq!(histogram.buckets.from_33_to_100_ms, 2);
        assert_eq!(histogram.buckets.at_least_100_ms, 1);
        assert_eq!(histogram.p50_us, Some(15_999));
        assert_eq!(histogram.p95_us, Some(100_000));
        assert_eq!(histogram.p99_us, Some(100_000));
        assert_eq!(histogram.max_us, Some(100_000));
    }

    #[test]
    fn histogram_discards_oldest_samples_at_capacity() {
        let observer = Observability::new(config(8, 3));
        for latency_us in [1_000, 2_000, 3_000, 100_000] {
            observer.observe_latency_us("render".to_owned(), latency_us);
        }

        let snapshot = observer.snapshot();
        let histogram = snapshot.latency_histograms.get("render").unwrap();
        assert_eq!(histogram.sample_count, 3);
        assert_eq!(histogram.total_observations, 4);
        assert_eq!(histogram.evicted_samples, 1);
        assert_eq!(histogram.buckets.under_4_ms, 2);
        assert_eq!(histogram.buckets.at_least_100_ms, 1);
        assert_eq!(histogram.max_us, Some(100_000));
    }

    #[test]
    fn counters_gauges_and_reset_are_consistent() {
        let observer = Observability::default();
        assert_eq!(observer.increment_counter("writes", 2), Some(2));
        assert_eq!(observer.increment_counter("writes", 3), Some(5));
        assert!(observer.set_gauge("queue", 4.5));
        assert!(!observer.set_gauge("invalid", f64::NAN));
        let before_id = observer.next_trace_id();

        let previous = observer.reset();
        assert_eq!(previous.counters.get("writes"), Some(&5));
        assert_eq!(previous.gauges.get("queue"), Some(&4.5));

        let current = observer.snapshot();
        assert!(current.counters.is_empty());
        assert!(current.gauges.is_empty());
        assert!(current.events.is_empty());
        assert!(observer.next_trace_id() > before_id);
    }

    #[test]
    fn slow_operation_records_histogram_and_drop_fallback() {
        let observer = Observability::default();
        observer
            .slow_operation("git.status", Duration::ZERO, None, Metadata::new())
            .finish(SpanOutcome::Success);
        {
            let _dropped =
                observer.slow_operation("git.status", Duration::ZERO, None, Metadata::new());
        }

        let snapshot = observer.snapshot();
        let histogram = snapshot.latency_histograms.get("git.status").unwrap();
        assert_eq!(histogram.sample_count, 2);
        let slow_events = snapshot
            .events
            .iter()
            .filter(|event| event.kind == EventKind::SlowOperation)
            .collect::<Vec<_>>();
        assert_eq!(slow_events.len(), 2);
        assert_eq!(slow_events[0].outcome, Some(SpanOutcome::Success));
        assert_eq!(slow_events[1].outcome, Some(SpanOutcome::Dropped));
    }

    #[test]
    fn heartbeat_delay_classification_has_deterministic_boundaries() {
        let threshold = Duration::from_millis(100);
        assert_eq!(
            classify_heartbeat_delay(Duration::from_secs(1), threshold, true, false),
            HeartbeatDelayClassification::Inactive
        );
        assert_eq!(
            classify_heartbeat_delay(Duration::from_millis(99), threshold, false, true),
            HeartbeatDelayClassification::Healthy
        );
        assert_eq!(
            classify_heartbeat_delay(Duration::from_millis(100), threshold, false, true),
            HeartbeatDelayClassification::HangStarted
        );
        assert_eq!(
            classify_heartbeat_delay(Duration::from_millis(101), threshold, true, true),
            HeartbeatDelayClassification::HangOngoing
        );
        assert_eq!(
            classify_heartbeat_delay(Duration::from_millis(1), threshold, true, true),
            HeartbeatDelayClassification::Recovered
        );
    }

    #[test]
    fn heartbeat_sequence_is_monotonic_and_state_is_explicit() {
        let heartbeat = Heartbeat::new();
        assert_eq!(heartbeat.beat(), 1);
        assert_eq!(heartbeat.beat(), 2);
        heartbeat.set_armed(false);
        heartbeat.set_visible(false);

        let snapshot = heartbeat.snapshot();
        assert_eq!(snapshot.sequence, 2);
        assert!(!snapshot.armed);
        assert!(!snapshot.visible);

        heartbeat.set_visible(true);
        heartbeat.set_armed(true);
        let reactivated = heartbeat.snapshot();
        assert!(reactivated.visible);
        assert!(reactivated.armed);
        assert!(reactivated.last_beat_us >= snapshot.last_beat_us);
    }

    #[test]
    fn ui_heartbeat_transition_requires_visible_forward_progress() {
        let mut progress = UiHeartbeatProgress::default();
        assert_eq!(
            classify_ui_heartbeat_update(&mut progress, true, 42),
            UiHeartbeatTransition::Activated
        );
        assert_eq!(
            classify_ui_heartbeat_update(&mut progress, true, 42),
            UiHeartbeatTransition::Unchanged
        );
        assert_eq!(
            classify_ui_heartbeat_update(&mut progress, true, 41),
            UiHeartbeatTransition::Unchanged
        );
        assert_eq!(
            classify_ui_heartbeat_update(&mut progress, true, 43),
            UiHeartbeatTransition::Advanced
        );
        assert_eq!(
            classify_ui_heartbeat_update(&mut progress, false, 43),
            UiHeartbeatTransition::Suspended
        );
        assert_eq!(
            classify_ui_heartbeat_update(&mut progress, true, 0),
            UiHeartbeatTransition::Activated
        );
    }

    #[test]
    fn managed_ui_heartbeat_starts_inactive_and_rebases_after_suspend() {
        let heartbeat = inactive_ui_heartbeat();
        let mut progress = UiHeartbeatProgress::default();
        let initial = heartbeat.snapshot();
        assert!(!initial.armed);
        assert!(!initial.visible);

        assert_eq!(
            apply_ui_heartbeat_update(&heartbeat, &mut progress, true, 7),
            UiHeartbeatTransition::Activated
        );
        let activated = heartbeat.snapshot();
        assert_eq!(activated.sequence, 1);
        assert!(activated.armed);
        assert!(activated.visible);

        assert_eq!(
            apply_ui_heartbeat_update(&heartbeat, &mut progress, true, 7),
            UiHeartbeatTransition::Unchanged
        );
        assert_eq!(heartbeat.snapshot().sequence, 1);
        assert_eq!(
            apply_ui_heartbeat_update(&heartbeat, &mut progress, true, 8),
            UiHeartbeatTransition::Advanced
        );
        assert_eq!(heartbeat.snapshot().sequence, 2);

        apply_ui_heartbeat_update(&heartbeat, &mut progress, false, 8);
        let suspended = heartbeat.snapshot();
        assert!(!suspended.armed);
        assert!(!suspended.visible);
        assert_eq!(
            apply_ui_heartbeat_update(&heartbeat, &mut progress, true, 0),
            UiHeartbeatTransition::Activated
        );
        let rebased = heartbeat.snapshot();
        assert_eq!(rebased.sequence, 3);
        assert!(rebased.armed);
        assert!(rebased.visible);
    }

    #[test]
    fn watchdog_sample_records_bounded_observability_data() {
        let observer = Observability::new(ObservabilityConfig {
            event_capacity: 8,
            latency_sample_capacity: 8,
            metric_series_capacity: 16,
            max_metadata_entries: 8,
            max_string_bytes: 128,
        });
        let watchdog_config = HangWatchdogConfig {
            name: "ui".to_owned(),
            sample_interval_ms: 25,
            hang_threshold_ms: 100,
            monitor_hidden: false,
        };
        let metric_names = WatchdogMetricNames::new(&watchdog_config.name);
        let heartbeat = HeartbeatSnapshot {
            sequence: 7,
            last_beat_us: 1,
            armed: true,
            visible: true,
        };

        record_watchdog_sample(
            &observer,
            &watchdog_config,
            &metric_names,
            heartbeat,
            125_000,
            HeartbeatDelayClassification::HangStarted,
        );

        let snapshot = observer.snapshot();
        assert_eq!(snapshot.counters.get("watchdog.ui.samples"), Some(&1));
        assert_eq!(snapshot.counters.get("watchdog.ui.hangs"), Some(&1));
        assert_eq!(
            snapshot.gauges.get("watchdog.ui.heartbeat_delay_us"),
            Some(&125_000.0)
        );
        assert_eq!(
            snapshot
                .latency_histograms
                .get("watchdog.ui.heartbeat_delay")
                .unwrap()
                .buckets
                .at_least_100_ms,
            1
        );
        assert_eq!(snapshot.events.len(), 1);
        assert_eq!(snapshot.events[0].name, "watchdog.hang_started");
    }

    #[test]
    fn watchdog_stop_interrupts_a_long_wait_without_sleeping() {
        let heartbeat = Heartbeat::new();
        let handle = start_hang_watchdog(
            heartbeat,
            HangWatchdogConfig {
                sample_interval_ms: 60_000,
                ..HangWatchdogConfig::default()
            },
        )
        .unwrap();
        handle.stop().unwrap();
    }

    #[test]
    fn managed_ui_watchdog_drop_stops_its_thread_without_sleeping() {
        let state = UiWatchdogState::start().unwrap();
        drop(state);
    }

    #[test]
    fn metadata_and_names_are_safely_bounded() {
        let observer = Observability::new(config(8, 8));
        let mut metadata = Metadata::new();
        for index in 0..8 {
            metadata.insert(
                format!("metadata-key-{index}"),
                ScalarValue::String("0123456789abcdefghijklmnop".to_owned()),
            );
        }
        observer.record_event("event-name-that-is-too-long", None, metadata);

        let snapshot = observer.snapshot();
        let event = &snapshot.events[0];
        assert!(event.name.len() <= 16);
        assert_eq!(event.metadata.len(), 4);
        assert!(event.metadata.keys().all(|key| key.len() <= 16));
        assert!(event.metadata.values().all(|value| match value {
            ScalarValue::String(value) => value.len() <= 16,
            _ => true,
        }));
    }
}

//! Lightweight, bounded process-local observability primitives.
//!
//! This module deliberately does not depend on a logging backend. It keeps a
//! small structured history that can be exposed through diagnostics, while
//! callers may independently forward snapshots to a tracing or telemetry
//! implementation. Values attached to events are scalar-only so diagnostics
//! cannot accidentally retain an arbitrary object graph.

use serde::Serialize;
use std::collections::{BTreeMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

const DEFAULT_EVENT_CAPACITY: usize = 512;
const DEFAULT_LATENCY_SAMPLE_CAPACITY: usize = 512;
const DEFAULT_METRIC_SERIES_CAPACITY: usize = 256;
const DEFAULT_METADATA_ENTRIES: usize = 16;
const DEFAULT_STRING_BYTES: usize = 256;

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

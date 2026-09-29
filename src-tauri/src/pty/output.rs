use std::collections::{hash_map::Entry, HashMap};
use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tauri::ipc::{Channel, Response};
use tauri::{Emitter, State};

use crate::error::{AppError, AppResult};
use crate::observability::{global_observability, Metadata, ScalarValue, SpanOutcome};

use super::agent_state::{note_agent_output, publish_agent_state};
use super::screen::{compact_parser_for_idle, reseed_parser, screen_scrollback_len};
use super::shell_protocol::{
    PtyShellMetadataEvent, ShellProtocolOutput, ShellProtocolUpdate, PTY_SHELL_METADATA_EVENT,
};
use super::task::notify_task_process_exited;
use super::{
    now_ms, pty_err, Pty, PtyManager, ACTIVITY_STOPPED, FLOW_CONTROL_WAIT, IDLE_SCROLLBACK,
    MAIN_WEBVIEW, MAX_PTY_SUBSCRIBERS_PER_PTY, MAX_SUB_ID_COLLISION_PROBES, MAX_UNACKED_BYTES,
    NEXT_SUB_ID, OBSERVED_BROADCASTS, OUTPUT_BROADCASTS, OUTPUT_BYTES, PARSER_SCROLLBACK,
    SLOW_BROADCAST,
};

type SubscriberSnapshot = Vec<(u32, Subscriber)>;

/// One attached xterm, plus how many bytes it has been sent but has not yet
/// reported writing. The renderer reports progress through `pty_ack`.
#[derive(Clone)]
pub(super) struct Subscriber {
    channel: Channel<Response>,
    unacked: Arc<AtomicUsize>,
}

impl Subscriber {
    fn new(channel: Channel<Response>) -> Self {
        Self {
            channel,
            unacked: Arc::new(AtomicUsize::new(0)),
        }
    }

    /// Sends one chunk and charges it against this subscriber's credit.
    /// Returns false when the channel is gone.
    pub(super) fn send(&self, bytes: &[u8]) -> bool {
        if self.channel.send(Response::new(bytes.to_vec())).is_err() {
            return false;
        }
        self.unacked.fetch_add(bytes.len(), Ordering::AcqRel);
        true
    }

    fn release(&self, bytes: usize) {
        let _ = self
            .unacked
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |outstanding| {
                Some(outstanding.saturating_sub(bytes))
            });
    }

    fn unacked(&self) -> usize {
        self.unacked.load(Ordering::Acquire)
    }
}

pub(super) fn subscribers_over_budget(subscribers: &HashMap<u32, Subscriber>) -> bool {
    subscribers
        .values()
        .any(|subscriber| subscriber.unacked() >= MAX_UNACKED_BYTES)
}

/// Holds the reader while a renderer is behind. Returns false when the wait
/// ran out, which means nobody is acking any more and the child must not be
/// held hostage to a renderer that will never answer.
pub(super) async fn await_subscriber_credit<F: Fn() -> bool>(
    flow_control: &tokio::sync::Notify,
    over_budget: F,
) -> bool {
    if !over_budget() {
        return true;
    }
    loop {
        // Register before re-reading the budget so an ack that lands in
        // between still wakes this wait.
        let notified = flow_control.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if !over_budget() {
            return true;
        }
        if tokio::time::timeout(FLOW_CONTROL_WAIT, notified)
            .await
            .is_err()
        {
            return false;
        }
    }
}

/// Update the headless terminal and fan one output chunk to live subscribers.
/// Both Unix's readiness task and Windows' ConPTY reader thread share this
/// path, preserving the snapshot/subscription ordering invariant.
pub(super) fn publish_shell_metadata(pty: &Pty, update: ShellProtocolUpdate) {
    if pty
        .app
        .emit_to(
            MAIN_WEBVIEW,
            PTY_SHELL_METADATA_EVENT,
            PtyShellMetadataEvent::from_update(pty.id, update),
        )
        .is_err()
    {
        let _ = global_observability().increment_counter("pty.shell_protocol.emit_errors", 1);
    }
}

pub(super) fn broadcast_output(pty: &Pty, bytes: &[u8]) {
    if pty.task_exit.is_some() {
        if let Ok(mut log) = pty.harness_output.lock() {
            log.push(bytes);
        }
        if !pty.harness_output_pending.swap(true, Ordering::AcqRel) {
            let pending = pty.harness_output_pending.clone();
            let app = pty.app.clone();
            let id = pty.id;
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(50)).await;
                pending.store(false, Ordering::Release);
                let _ = app.emit_to(MAIN_WEBVIEW, "harness-task-output", id);
            });
        }
    }
    let observer = global_observability();
    // Every observability call allocates a name and takes one global lock, and
    // this runs for every chunk of every PTY. Instrument a sample, plus
    // anything that turns out to be slow.
    let sampled = OUTPUT_BROADCASTS
        .fetch_add(1, Ordering::Relaxed)
        .is_multiple_of(OBSERVED_BROADCASTS);
    let operation = sampled.then(|| {
        let mut metadata = Metadata::new();
        metadata.insert("bytes".to_owned(), ScalarValue::from(bytes.len()));
        observer.slow_operation("pty.broadcast", SLOW_BROADCAST, None, metadata)
    });
    let broadcast_started = Instant::now();
    let outcome = fan_out_output(pty, bytes, sampled);
    match operation {
        Some(operation) => {
            operation.finish(outcome);
        }
        None => {
            let elapsed = broadcast_started.elapsed();
            if elapsed >= SLOW_BROADCAST {
                observer.observe_latency("pty.broadcast", elapsed);
            }
        }
    }
}

/// Feeds one chunk to the headless parser and then to every live subscriber.
fn fan_out_output(pty: &Pty, bytes: &[u8], sampled: bool) -> SpanOutcome {
    let observer = global_observability();
    OUTPUT_BYTES.fetch_add(bytes.len() as u64, Ordering::Relaxed);
    let output_now_ms = now_ms();
    pty.last_activity_ms.store(output_now_ms, Ordering::Relaxed);
    note_agent_output(pty);
    let (snapshot, shell_output): (SubscriberSnapshot, ShellProtocolOutput) = {
        let parser_started = Instant::now();
        let Ok(mut parser) = pty.parser.lock() else {
            let _ = observer.increment_counter("pty.parser.lock_errors", 1);
            return SpanOutcome::Error;
        };
        if pty.trimmed.swap(false, Ordering::AcqRel) {
            reseed_parser(&mut parser, PARSER_SCROLLBACK);
        }
        // This bounded side parser observes OSC 7/133 without filtering or
        // rewriting output. The vt100 model and every attached xterm still
        // receive the original byte slice verbatim.
        let shell_batch = parser
            .callbacks_mut()
            .shell
            .as_mut()
            .map(|shell| shell.process_for_events(bytes, output_now_ms))
            .unwrap_or_default();
        parser.process(bytes);
        if sampled {
            observer.observe_latency("pty.parser", parser_started.elapsed());
        }
        pty.activity_revision.fetch_add(1, Ordering::AcqRel);
        let subscribers = match pty.subscribers.lock() {
            Ok(subs) => subs
                .iter()
                .map(|(id, subscriber)| (*id, subscriber.clone()))
                .collect(),
            Err(_) => Vec::new(),
        };
        (subscribers, shell_batch)
    };
    if shell_output.coalesced > 0 {
        let _ = observer.increment_counter(
            "pty.shell_protocol.coalesced",
            shell_output.coalesced as u64,
        );
    }
    if shell_output.dropped > 0 {
        let _ =
            observer.increment_counter("pty.shell_protocol.dropped", shell_output.dropped as u64);
    }
    if let Some(update) = shell_output.ready {
        publish_shell_metadata(pty, update);
    }
    if snapshot.is_empty() {
        return SpanOutcome::Success;
    }
    if sampled {
        observer.set_gauge("pty.last_subscriber_fanout", snapshot.len() as f64);
    }
    let send_started = Instant::now();
    let dead: Vec<u32> = snapshot
        .iter()
        .filter_map(|(sub_id, subscriber)| (!subscriber.send(bytes)).then_some(*sub_id))
        .collect();
    if sampled {
        observer.observe_latency("pty.channel_send", send_started.elapsed());
    }
    if !dead.is_empty() {
        let _ = observer.increment_counter("pty.channel_send_errors", dead.len() as u64);
    }
    if let Ok(mut subscribers) = pty.subscribers.lock() {
        for sub_id in dead {
            subscribers.remove(&sub_id);
        }
    }
    SpanOutcome::Success
}

pub(super) fn notify_process_exited(pty: &Pty, status: Option<&portable_pty::ExitStatus>) {
    notify_task_process_exited(pty, status);
    if let Ok(subscribers) = pty.subscribers.lock() {
        for subscriber in subscribers.values() {
            subscriber.send(&[]);
        }
    }
    if pty.agent_kind.is_some() && pty.report_exit.load(Ordering::Acquire) {
        let reason = status.map_or_else(
            || "agent process stopped; exit status unavailable".to_string(),
            |status| {
                if status.success() {
                    "agent process stopped".to_string()
                } else {
                    status.signal().map_or_else(
                        || format!("agent process stopped with code {}", status.exit_code()),
                        |signal| format!("agent process stopped from signal {signal}"),
                    )
                }
            },
        );
        publish_agent_state(
            pty,
            ACTIVITY_STOPPED,
            "stopped",
            "process",
            "high",
            reason,
            None,
        );
    }
}

pub(super) fn insert_subscriber(
    subscribers: &mut HashMap<u32, Subscriber>,
    next_id: &AtomicU32,
    on_event: Channel<Response>,
) -> AppResult<u32> {
    if subscribers.len() >= MAX_PTY_SUBSCRIBERS_PER_PTY {
        return Err(AppError::Pty("PTY subscriber capacity reached".into()));
    }
    // Allocation happens under the same map lock as insertion. A wrapped
    // process-global counter can therefore skip zero and every still-live ID
    // instead of replacing a channel that a stale unsubscribe still names.
    for _ in 0..MAX_SUB_ID_COLLISION_PROBES {
        let sub_id = next_id.fetch_add(1, Ordering::Relaxed);
        if sub_id == 0 {
            continue;
        }
        if let Entry::Vacant(entry) = subscribers.entry(sub_id) {
            entry.insert(Subscriber::new(on_event));
            return Ok(sub_id);
        }
    }
    Err(AppError::Pty("PTY subscriber id capacity exhausted".into()))
}

#[tauri::command]
pub async fn pty_subscribe(
    manager: State<'_, PtyManager>,
    id: u32,
    on_event: Channel<Response>,
) -> AppResult<u32> {
    let pty = manager
        .ptys
        .get(&id)
        .map(|entry| entry.value().clone())
        .ok_or(AppError::BadArg("pty not found"))?;
    let mut subscribers = pty.subscribers.lock().map_err(pty_err)?;
    insert_subscriber(&mut subscribers, &NEXT_SUB_ID, on_event)
}

/// A renderer that stopped answering keeps no credit. The frontend's own
/// backlog cap remains the last resort if it is merely slow.
pub(super) fn forgive_unacked(pty: &Pty) {
    let Ok(subscribers) = pty.subscribers.lock() else {
        return;
    };
    for subscriber in subscribers.values() {
        subscriber.release(usize::MAX);
    }
    let _ = global_observability().increment_counter("pty.flow_control.abandoned", 1);
}

/// Reports how many delivered bytes a renderer has finished writing, which
/// releases the reader to pull more from the child.
#[tauri::command]
pub async fn pty_ack(
    manager: State<'_, PtyManager>,
    id: u32,
    sub_id: u32,
    bytes: usize,
) -> AppResult<()> {
    let Some(pty) = manager.ptys.get(&id).map(|entry| entry.value().clone()) else {
        return Ok(());
    };
    if let Ok(subscribers) = pty.subscribers.lock() {
        let Some(subscriber) = subscribers.get(&sub_id) else {
            return Ok(());
        };
        subscriber.release(bytes);
    }
    pty.flow_control.notify_waiters();
    Ok(())
}

#[tauri::command]
pub async fn pty_unsubscribe(
    manager: State<'_, PtyManager>,
    id: u32,
    sub_id: u32,
) -> AppResult<()> {
    let Some(pty) = manager.ptys.get(&id).map(|entry| entry.value().clone()) else {
        return Ok(());
    };
    tauri::async_runtime::spawn_blocking(move || unsubscribe_locked(&pty, sub_id))
        .await
        .map_err(|e| AppError::Pty(format!("pty_unsubscribe join: {e}")))?;
    Ok(())
}

fn unsubscribe_locked(pty: &Pty, sub_id: u32) {
    let emptied = match pty.subscribers.lock() {
        Ok(mut subs) => {
            subs.remove(&sub_id);
            subs.is_empty()
        }
        Err(_) => return,
    };
    // Whatever this renderer still owed left with it.
    pty.flow_control.notify_waiters();
    if !emptied || pty.trimmed.load(Ordering::Acquire) {
        return;
    }
    // Nobody is looking any more, so hold only what a reattach replays. Take
    // the locks in the reader's parser -> subscribers order, and re-check
    // under the parser lock so an attach that raced us keeps its history.
    let Ok(mut parser) = pty.parser.lock() else {
        return;
    };
    let still_empty = match pty.subscribers.lock() {
        Ok(subs) => subs.is_empty(),
        Err(_) => false,
    };
    if !still_empty {
        return;
    }
    // Most terminals never accumulate more history than the idle size, and
    // rebuilding the parser for nothing would just churn on every tab switch.
    if screen_scrollback_len(parser.screen_mut()) <= IDLE_SCROLLBACK {
        return;
    }
    if compact_parser_for_idle(&mut parser) {
        pty.trimmed.store(true, Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::{await_subscriber_credit, insert_subscriber, subscribers_over_budget, Subscriber};
    use crate::pty::{MAX_PTY_SUBSCRIBERS_PER_PTY, MAX_UNACKED_BYTES};
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    fn output_channel() -> tauri::ipc::Channel<tauri::ipc::Response> {
        tauri::ipc::Channel::new(|_| Ok(()))
    }

    #[test]
    fn subscriber_capacity_and_wrapped_ids_never_replace_a_live_channel() {
        let next_id = AtomicU32::new(1);
        let mut subscribers = HashMap::new();
        let mut live_ids = Vec::new();
        for _ in 0..MAX_PTY_SUBSCRIBERS_PER_PTY {
            live_ids.push(
                insert_subscriber(&mut subscribers, &next_id, output_channel())
                    .expect("subscriber below cap"),
            );
        }
        assert_eq!(subscribers.len(), MAX_PTY_SUBSCRIBERS_PER_PTY);
        assert!(insert_subscriber(&mut subscribers, &next_id, output_channel()).is_err());
        assert_eq!(subscribers.len(), MAX_PTY_SUBSCRIBERS_PER_PTY);

        let removed = live_ids.remove(0);
        assert!(subscribers.remove(&removed).is_some());
        let replacement = insert_subscriber(&mut subscribers, &next_id, output_channel())
            .expect("released subscriber slot");
        assert!(!live_ids.contains(&replacement));
        assert_eq!(subscribers.len(), MAX_PTY_SUBSCRIBERS_PER_PTY);

        let wrapped_next = AtomicU32::new(u32::MAX);
        let mut wrapped = HashMap::from([(u32::MAX, Subscriber::new(output_channel()))]);
        let wrapped_id = insert_subscriber(&mut wrapped, &wrapped_next, output_channel())
            .expect("wrap skips zero and live id");
        assert_eq!(wrapped_id, 1);
        assert!(wrapped.contains_key(&u32::MAX));
        assert!(wrapped.contains_key(&wrapped_id));
    }

    fn backlogged_subscribers() -> (Arc<Mutex<HashMap<u32, Subscriber>>>, u32) {
        let subscribers = Arc::new(Mutex::new(HashMap::new()));
        let next_id = AtomicU32::new(1);
        let mut guard = subscribers.lock().expect("subscribers");
        let sub_id =
            insert_subscriber(&mut guard, &next_id, output_channel()).expect("first subscriber");
        guard
            .get(&sub_id)
            .expect("subscriber")
            .unacked
            .store(MAX_UNACKED_BYTES, Ordering::Release);
        drop(guard);
        (subscribers, sub_id)
    }

    #[tokio::test]
    async fn a_backlogged_subscriber_holds_the_reader_until_it_acks() {
        let (subscribers, sub_id) = backlogged_subscribers();
        let flow_control = Arc::new(tokio::sync::Notify::new());
        let waiting = tokio::spawn({
            let subscribers = subscribers.clone();
            let flow_control = flow_control.clone();
            async move {
                await_subscriber_credit(&flow_control, || {
                    subscribers_over_budget(&subscribers.lock().expect("subscribers"))
                })
                .await
            }
        });

        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(
            !waiting.is_finished(),
            "the reader ran while a renderer was behind"
        );

        subscribers
            .lock()
            .expect("subscribers")
            .get(&sub_id)
            .expect("subscriber")
            .release(MAX_UNACKED_BYTES);
        flow_control.notify_waiters();

        assert!(
            waiting.await.expect("wait task"),
            "the ack did not resume the reader"
        );
    }

    #[tokio::test]
    async fn a_renderer_that_stops_acking_does_not_hold_the_reader_forever() {
        let (subscribers, _) = backlogged_subscribers();
        let flow_control = tokio::sync::Notify::new();
        let resumed = await_subscriber_credit(&flow_control, || {
            subscribers_over_budget(&subscribers.lock().expect("subscribers"))
        })
        .await;
        assert!(!resumed, "a silent renderer must not stall the child");
    }
}

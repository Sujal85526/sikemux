use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::{AppHandle, Manager};

use sikemux_pty::agent_detection::{AgentDetectionState, DetectionConfidence, DetectionInput};
use sikemux_pty::screen::compact_parser_for_idle;

use super::agent_state::{detection_reason, publish_agent_state, semantic_fingerprint};
use super::output::publish_shell_metadata;
use super::task::reclaim_completed_task_ptys;
use super::{
    now_ms, Pty, PtyManager, ACTIVITY_BLOCKED, ACTIVITY_IDLE, ACTIVITY_POLL_INTERVAL,
    ACTIVITY_SETTLE, ACTIVITY_UNKNOWN, ACTIVITY_WORKING, IDLE_TRIM, SWEEP_INTERVAL,
};

/// One-shot sweeper kickoff. Spawns a single background task on the first
/// `pty_spawn` of the process; subsequent calls are no-ops.
pub(super) fn ensure_sweeper(app: AppHandle) {
    static SPAWNED: AtomicBool = AtomicBool::new(false);
    if SPAWNED.swap(true, Ordering::Relaxed) {
        return;
    }
    let activity_app = app.clone();
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(ACTIVITY_POLL_INTERVAL);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            ticker.tick().await;
            let Some(mgr) = activity_app.try_state::<PtyManager>() else {
                return;
            };
            let now = now_ms();
            for entry in mgr.ptys.iter() {
                let pty = entry.value();
                // A quiet prompt may leave one coalesced update after its last
                // output chunk. Flush it from the existing bounded sweeper so
                // rate limiting never means "latest state is never emitted".
                if pty.shell_protocol {
                    let shell_update = pty.parser.lock().ok().and_then(|mut parser| {
                        parser
                            .callbacks_mut()
                            .shell
                            .as_mut()
                            .and_then(|shell| shell.take_due_event(now))
                    });
                    if let Some(update) = shell_update {
                        publish_shell_metadata(pty, update);
                    }
                }
                if !pty.activity_armed.load(Ordering::Acquire)
                    || now.saturating_sub(pty.last_activity_ms.load(Ordering::Relaxed))
                        < ACTIVITY_SETTLE.as_millis() as u64
                {
                    continue;
                }
                let Some(agent) = pty.agent_kind else {
                    continue;
                };
                // Nothing has reached the parser since the last scan, so the
                // screen still says exactly what it said then.
                let revision = pty.activity_revision.load(Ordering::Acquire);
                if pty.last_detection_revision.load(Ordering::Acquire) == revision {
                    continue;
                }
                let (recent, title) = match pty.parser.lock() {
                    Ok(parser) => (
                        parser.screen().contents(),
                        parser.callbacks().window_title.clone(),
                    ),
                    Err(_) => continue,
                };
                let fingerprint = semantic_fingerprint(revision, &recent, &title);
                if pty.last_detection_fingerprint.load(Ordering::Acquire) == fingerprint {
                    continue;
                }
                let detection = match mgr.detection_registry.read() {
                    Ok(registry) => {
                        let input = if title.is_empty() {
                            DetectionInput::screen(&recent)
                        } else {
                            DetectionInput {
                                recent_screen: &recent,
                                osc_title: &title,
                                osc_progress: "",
                            }
                        };
                        registry.detect(agent, input)
                    }
                    Err(_) => continue,
                };
                if detection.skip_state_update {
                    pty.last_detection_fingerprint
                        .store(fingerprint, Ordering::Release);
                    pty.last_detection_revision
                        .store(revision, Ordering::Release);
                    continue;
                }
                let (next, label) = match detection.state {
                    AgentDetectionState::Unknown => (ACTIVITY_UNKNOWN, "unknown"),
                    AgentDetectionState::Idle => (ACTIVITY_IDLE, "idle"),
                    AgentDetectionState::Working => (ACTIVITY_WORKING, "working"),
                    AgentDetectionState::Blocked => (ACTIVITY_BLOCKED, "blocked"),
                };
                if next == ACTIVITY_IDLE {
                    let confirmations = pty.idle_confirmations.fetch_add(1, Ordering::AcqRel) + 1;
                    if confirmations < 2 {
                        continue;
                    }
                } else {
                    pty.idle_confirmations.store(0, Ordering::Release);
                }
                let source = if detection.fallback_reason.is_some() {
                    "fallback"
                } else {
                    "screen"
                };
                let confidence = match detection.confidence {
                    DetectionConfidence::Authoritative | DetectionConfidence::Strong => "high",
                    DetectionConfidence::Fallback => "low",
                };
                let reason = detection_reason(&detection);
                publish_agent_state(
                    pty,
                    next,
                    label,
                    source,
                    confidence,
                    reason,
                    detection.matched_rule,
                );
                pty.last_detection_fingerprint
                    .store(fingerprint, Ordering::Release);
                pty.last_detection_revision
                    .store(revision, Ordering::Release);
            }
        }
    });
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(SWEEP_INTERVAL);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        ticker.tick().await; // skip the immediate first tick
        loop {
            ticker.tick().await;
            let Some(mgr) = app.try_state::<PtyManager>() else {
                return;
            };
            let now = now_ms();
            reclaim_completed_task_ptys(&mgr, now);
            // Snapshot identities after reclamation so parser compaction never
            // holds a DashMap shard across parser/subscriber locks.
            let candidates: Vec<Arc<Pty>> =
                mgr.ptys.iter().map(|entry| entry.value().clone()).collect();
            for pty in candidates {
                if pty.trimmed.load(Ordering::Relaxed) {
                    continue;
                }
                let last = pty.last_activity_ms.load(Ordering::Relaxed);
                if now.saturating_sub(last) < IDLE_TRIM.as_millis() as u64 {
                    continue;
                }
                let has_subs = match pty.subscribers.lock() {
                    Ok(s) => !s.is_empty(),
                    Err(_) => true, // be conservative on poison
                };
                if has_subs {
                    // Don't shrink under an attached xterm — a reattach
                    // would lose scrollback the user might be scrolling
                    // through right now.
                    continue;
                }
                // Re-seed the parser at the smaller scrollback. Alternate
                // screen applications must not be compacted: rebuilding an
                // alternate buffer can destroy the saved normal buffer that
                // 1049l is expected to restore.
                if let Ok(mut parser) = pty.parser.lock() {
                    // Output records activity before taking this lock. Re-read
                    // it here so bytes that raced the optimistic check above
                    // cannot be immediately compacted back to 2,000 rows.
                    let last = pty.last_activity_ms.load(Ordering::Relaxed);
                    if now.saturating_sub(last) < IDLE_TRIM.as_millis() as u64 {
                        continue;
                    }
                    // `pty_attach` takes parser -> subscribers in this same
                    // order. Re-check under the parser lock so an attach that
                    // raced the optimistic check above cannot receive a
                    // snapshot and then have its backing parser compacted.
                    let has_subs = match pty.subscribers.lock() {
                        Ok(s) => !s.is_empty(),
                        Err(_) => true,
                    };
                    if has_subs {
                        continue;
                    }
                    if compact_parser_for_idle(&mut parser) {
                        // Publish the capacity change while still holding the
                        // parser lock. The reader clears this flag and grows
                        // the parser under the same lock before processing its
                        // first new bytes, so no output can land in between.
                        pty.trimmed.store(true, Ordering::Release);
                    }
                }
            }
        }
    });
}

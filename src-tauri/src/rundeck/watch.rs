// Live execution watcher — polls /execution/{id} + /execution/{id}/state
// every 1.5s, emits a single combined payload to the frontend's Channel on
// each tick (so even unchanged ticks act as a heartbeat). Auto-stops when
// the execution reaches a terminal state.
//
// The frontend gets one watcher per execution view. WatchManager is keyed
// by an integer id so the UI can explicitly stop the loop on unmount.

use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use dashmap::DashMap;
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;
use tokio::task::JoinHandle;
use tokio::time::sleep;

use crate::error::AppResult;

use super::client::get_json;
use super::executions::{Execution, WorkflowState};

#[derive(Default)]
pub struct WatchManager {
    handles: DashMap<u32, JoinHandle<()>>,
}

impl WatchManager {
    pub fn count(&self) -> usize {
        self.handles.len()
    }
}

static NEXT_ID: AtomicU32 = AtomicU32::new(1);

#[derive(Serialize, Clone)]
pub struct WatchUpdate {
    pub execution: Option<Execution>,
    pub state: Option<WorkflowState>,
    pub error: Option<String>,
    pub terminal: bool,
}

fn is_terminal(status: &Option<String>) -> bool {
    status.as_deref().is_some_and(|value| {
        matches!(
            value.to_ascii_lowercase().as_str(),
            "succeeded" | "failed" | "aborted" | "timedout" | "missed" | "other-failed"
        )
    })
}

fn state_is_terminal(state: &WorkflowState) -> bool {
    state.completed.unwrap_or(false) || is_terminal(&state.execution_state)
}

#[tauri::command]
pub async fn rnd_watch_start(
    app: tauri::AppHandle,
    manager: State<'_, WatchManager>,
    execution_id: u64,
    on_update: Channel<WatchUpdate>,
) -> AppResult<u32> {
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    // Gate task execution until its handle is visible. Without this, a fast
    // terminal/error response can self-prune before insert, after which start
    // inserts a permanently-finished JoinHandle.
    let (start_tx, start_rx) = tokio::sync::oneshot::channel();
    let handle = tokio::spawn(async move {
        if start_rx.await.is_err() {
            return;
        }
        let mut last_status: Option<String> = None;
        let mut consecutive_errors: u32 = 0;
        let mut terminal_settle_polls: u32 = 0;
        const POLL_INTERVAL: Duration = Duration::from_millis(1500);
        const MAX_BACKOFF: Duration = Duration::from_secs(30);
        const ERROR_GIVEUP: u32 = 8;

        loop {
            let execution_path = format!("/execution/{execution_id}");
            let state_path = format!("/execution/{execution_id}/state");
            let (exec_res, state_res): (AppResult<Execution>, AppResult<WorkflowState>) =
                tokio::join!(get_json(&execution_path, &[]), get_json(&state_path, &[]));

            let both_failed = exec_res.is_err() && state_res.is_err();
            let (execution, state, error) = match (exec_res, state_res) {
                (Ok(e), Ok(s)) => {
                    last_status = e.status.clone();
                    (Some(e), Some(s), None)
                }
                (Ok(e), Err(se)) => {
                    last_status = e.status.clone();
                    (Some(e), None, Some(se.to_string()))
                }
                (Err(ee), Ok(s)) => (None, Some(s), Some(ee.to_string())),
                (Err(ee), Err(_)) => (None, None, Some(ee.to_string())),
            };

            if both_failed {
                consecutive_errors = consecutive_errors.saturating_add(1);
            } else {
                consecutive_errors = 0;
            }

            let execution_terminal = is_terminal(&last_status);
            let workflow_terminal = state.as_ref().is_some_and(state_is_terminal);
            if execution_terminal && !workflow_terminal {
                terminal_settle_polls = terminal_settle_polls.saturating_add(1);
            } else {
                terminal_settle_polls = 0;
            }
            let terminal = (workflow_terminal && (execution_terminal || execution.is_none()))
                || terminal_settle_polls >= 6
                || consecutive_errors >= ERROR_GIVEUP;
            let payload = WatchUpdate {
                execution,
                state,
                error,
                terminal,
            };

            // Send result; bail out if the channel is closed (UI unmounted).
            if on_update.send(payload).is_err() {
                break;
            }
            if terminal {
                break;
            }

            let sleep_dur = if consecutive_errors == 0 {
                POLL_INTERVAL
            } else {
                let exp = 1u64 << consecutive_errors.min(6);
                Duration::from_millis((POLL_INTERVAL.as_millis() as u64).saturating_mul(exp))
                    .min(MAX_BACKOFF)
            };
            sleep(sleep_dur).await;
        }
        // Self-prune so terminated executions don't leak JoinHandles. The
        // stop command is still useful for the "user navigates away mid-
        // run" path; this one covers natural-exit + channel-close.
        use tauri::Manager;
        if let Some(mgr) = app.try_state::<WatchManager>() {
            mgr.handles.remove(&id);
        }
    });
    manager.handles.insert(id, handle);
    let _ = start_tx.send(());
    Ok(id)
}

#[tauri::command]
pub fn rnd_watch_stop(manager: State<'_, WatchManager>, id: u32) {
    if let Some((_, handle)) = manager.handles.remove(&id) {
        handle.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_execution_and_workflow_terminal_states_case_insensitively() {
        assert!(is_terminal(&Some("other-failed".into())));
        assert!(is_terminal(&Some("SUCCEEDED".into())));
        assert!(state_is_terminal(&WorkflowState {
            execution_state: Some("FAILED".into()),
            ..WorkflowState::default()
        }));
    }

    #[test]
    fn completed_workflow_is_terminal_even_without_a_state_name() {
        assert!(state_is_terminal(&WorkflowState {
            completed: Some(true),
            ..WorkflowState::default()
        }));
    }
}

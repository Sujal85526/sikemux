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

static NEXT_ID: AtomicU32 = AtomicU32::new(1);

#[derive(Serialize, Clone)]
pub struct WatchUpdate {
    pub execution: Option<Execution>,
    pub state: Option<WorkflowState>,
    pub error: Option<String>,
    pub terminal: bool,
}

fn is_terminal(status: &Option<String>) -> bool {
    matches!(
        status.as_deref(),
        Some("succeeded" | "failed" | "aborted" | "timedout" | "missed" | "other-failed")
    )
}

#[tauri::command]
pub async fn rnd_watch_start(
    manager: State<'_, WatchManager>,
    execution_id: u64,
    on_update: Channel<WatchUpdate>,
) -> AppResult<u32> {
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let handles_ref = manager.inner();
    let handle = tokio::spawn(async move {
        let mut last_status: Option<String> = None;
        loop {
            let exec_res: AppResult<Execution> =
                get_json(&format!("/execution/{execution_id}"), &[]).await;
            let state_res: AppResult<WorkflowState> =
                get_json(&format!("/execution/{execution_id}/state"), &[]).await;

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

            let terminal = is_terminal(&last_status);
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
            sleep(Duration::from_millis(1500)).await;
        }
    });
    // We keep the handle so a stop request can abort the task. DashMap drop
    // also clears it if the loop ends naturally; we just keep the spurious
    // dead handle around until the user explicitly stops.
    manager.handles.insert(id, handle);
    let _ = handles_ref; // silence unused — manager.inner() already gave us reference; the insert above uses it
    Ok(id)
}

#[tauri::command]
pub fn rnd_watch_stop(manager: State<'_, WatchManager>, id: u32) {
    if let Some((_, handle)) = manager.handles.remove(&id) {
        handle.abort();
    }
}

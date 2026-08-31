// Live log tail via /execution/{id}/output. Rundeck returns an offset cursor
// (`offset` + `lastModified`) so each poll returns only the new bytes, with
// per-entry step context (`stepctx`) the UI uses to filter by step.

use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use dashmap::DashMap;
use serde::{Deserialize, Deserializer, Serialize};
use tauri::ipc::Channel;
use tauri::State;
use tokio::task::JoinHandle;
use tokio::time::sleep;

use crate::error::AppResult;

use super::client::get_json;

#[derive(Default)]
pub struct LogsManager {
    handles: DashMap<u32, JoinHandle<()>>,
}

impl LogsManager {
    pub fn count(&self) -> usize {
        self.handles.len()
    }
}

static NEXT_ID: AtomicU32 = AtomicU32::new(1);

#[derive(Serialize, Clone, Deserialize)]
pub struct LogEntry {
    pub time: Option<String>,
    pub level: Option<String>,
    pub log: Option<String>,
    pub user: Option<String>,
    #[serde(rename = "stepctx")]
    pub step_ctx: Option<String>,
    pub node: Option<String>,
}

#[derive(Serialize, Clone, Deserialize)]
pub struct LogChunk {
    pub completed: Option<bool>,
    #[serde(default, deserialize_with = "deserialize_cursor")]
    pub offset: Option<String>,
    #[serde(
        rename = "lastModified",
        default,
        deserialize_with = "deserialize_cursor"
    )]
    pub last_modified: Option<String>,
    #[serde(rename = "execCompleted")]
    pub exec_completed: Option<bool>,
    #[serde(rename = "execState")]
    pub exec_state: Option<String>,
    #[serde(default)]
    pub entries: Vec<LogEntry>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum CursorValue {
    String(String),
    Signed(i64),
    Unsigned(u64),
}

fn deserialize_cursor<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(
        Option::<CursorValue>::deserialize(deserializer)?.map(|value| match value {
            CursorValue::String(value) => value,
            CursorValue::Signed(value) => value.to_string(),
            CursorValue::Unsigned(value) => value.to_string(),
        }),
    )
}

#[derive(Serialize, Clone)]
pub struct LogTick {
    pub entries: Vec<LogEntry>,
    pub completed: bool,
    pub error: Option<String>,
}

/// Start tailing log output. `backlog` replays N lines on subscribe; pass
/// 0 or None to read from the beginning.
#[tauri::command]
pub async fn rnd_logs_start(
    app: tauri::AppHandle,
    manager: State<'_, LogsManager>,
    execution_id: u64,
    backlog: Option<u32>,
    on_chunk: Channel<LogTick>,
) -> AppResult<u32> {
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    // Gate execution until the handle is in the manager. Otherwise a closed
    // channel or immediately-completed execution can self-remove before the
    // insert below and leave a dead handle behind.
    let (start_tx, start_rx) = tokio::sync::oneshot::channel();
    let handle = tokio::spawn(async move {
        if start_rx.await.is_err() {
            return;
        }
        let mut offset = String::from("0");
        let mut last_modified: Option<String> = None;
        let mut first_pass = true;
        // Exponential backoff on consecutive transport errors so a stale
        // token / network outage doesn't turn into a 1.5s-poll DoS against
        // the Rundeck instance for the life of the app session.
        let mut consecutive_errors: u32 = 0;
        const MAX_BACKOFF: Duration = Duration::from_secs(30);
        const POLL_INTERVAL: Duration = Duration::from_millis(1500);
        const ERROR_GIVEUP: u32 = 8;

        loop {
            let mut query: Vec<(&str, String)> = vec![("format", "json".into())];
            if first_pass {
                if let Some(n) = backlog {
                    if n > 0 {
                        query.push(("lastlines", n.to_string()));
                    } else {
                        query.push(("offset", offset.clone()));
                    }
                } else {
                    query.push(("offset", offset.clone()));
                }
                first_pass = false;
            } else {
                query.push(("offset", offset.clone()));
                if let Some(lm) = &last_modified {
                    query.push(("lastmod", lm.clone()));
                }
            }

            let res: AppResult<LogChunk> =
                get_json(&format!("/execution/{execution_id}/output"), &query).await;

            let mut sleep_dur = POLL_INTERVAL;
            match res {
                Ok(chunk) => {
                    consecutive_errors = 0;
                    if let Some(o) = &chunk.offset {
                        offset = o.clone();
                    }
                    if chunk.last_modified.is_some() {
                        last_modified = chunk.last_modified.clone();
                    }
                    let completed = log_stream_completed(&chunk);
                    let tick = LogTick {
                        entries: chunk.entries,
                        completed,
                        error: None,
                    };
                    if on_chunk.send(tick).is_err() {
                        break;
                    }
                    if completed {
                        break;
                    }
                }
                Err(e) => {
                    consecutive_errors = consecutive_errors.saturating_add(1);
                    let tick = LogTick {
                        entries: vec![],
                        completed: consecutive_errors >= ERROR_GIVEUP,
                        error: Some(e.to_string()),
                    };
                    if on_chunk.send(tick).is_err() {
                        break;
                    }
                    if consecutive_errors >= ERROR_GIVEUP {
                        // Surrender — the UI will surface the last error and
                        // the user can re-mount the pane to retry. Better
                        // than hammering an unreachable instance forever.
                        break;
                    }
                    // 1.5s, 3s, 6s, 12s, 24s, 30s (capped).
                    let exp = 1u64 << consecutive_errors.min(6);
                    sleep_dur = Duration::from_millis(
                        (POLL_INTERVAL.as_millis() as u64).saturating_mul(exp),
                    )
                    .min(MAX_BACKOFF);
                }
            }
            sleep(sleep_dur).await;
        }
        // Self-prune from the DashMap so terminated executions don't
        // accumulate dead JoinHandles for the rest of the session.
        use tauri::Manager;
        if let Some(mgr) = app.try_state::<LogsManager>() {
            mgr.handles.remove(&id);
        }
    });
    manager.handles.insert(id, handle);
    let _ = start_tx.send(());
    Ok(id)
}

fn log_stream_completed(chunk: &LogChunk) -> bool {
    chunk.completed.unwrap_or(false) && chunk.exec_completed.unwrap_or(false)
}

#[tauri::command]
pub fn rnd_logs_stop(manager: State<'_, LogsManager>, id: u32) {
    if let Some((_, handle)) = manager.handles.remove(&id) {
        handle.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_numeric_and_string_output_cursors() {
        let numeric: LogChunk = serde_json::from_str(
            r#"{"completed":false,"offset":12,"lastModified":34,"execCompleted":false,"entries":[]}"#,
        )
        .unwrap();
        let string: LogChunk = serde_json::from_str(
            r#"{"completed":false,"offset":"56","lastModified":"78","execCompleted":false,"entries":[]}"#,
        )
        .unwrap();

        assert_eq!(numeric.offset.as_deref(), Some("12"));
        assert_eq!(numeric.last_modified.as_deref(), Some("34"));
        assert_eq!(string.offset.as_deref(), Some("56"));
        assert_eq!(string.last_modified.as_deref(), Some("78"));
    }

    #[test]
    fn keeps_tailing_until_execution_and_output_are_complete() {
        let mut chunk: LogChunk = serde_json::from_str(
            r#"{"completed":true,"offset":12,"lastModified":34,"execCompleted":false,"entries":[]}"#,
        )
        .unwrap();

        assert!(!log_stream_completed(&chunk));
        chunk.exec_completed = Some(true);
        assert!(log_stream_completed(&chunk));
    }
}

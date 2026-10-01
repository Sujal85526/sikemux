use std::collections::HashMap;
use std::sync::{mpsc, Mutex};
use std::time::Duration;

use serde_json::Value;
pub use sikemux_core::cli::protocol::HarnessRequest;
use tauri::{Emitter, State};

use crate::cli_server::CliBrokerState;

mod tool_calls;

pub const MAX_PENDING: usize = 64;
const REPLY_TIMEOUT: Duration = Duration::from_secs(65);

struct Pending {
    request: HarnessRequest,
    claimed: bool,
    reply: mpsc::Sender<Result<Value, String>>,
}

#[derive(Default)]
pub struct HarnessBroker {
    pending: Mutex<HashMap<String, Pending>>,
}

impl HarnessBroker {
    pub fn enqueue(
        &self,
        request: HarnessRequest,
    ) -> Result<mpsc::Receiver<Result<Value, String>>, String> {
        request.validate()?;
        let mut pending = self.pending.lock().map_err(|_| "harness lock poisoned")?;
        if pending.len() >= MAX_PENDING || pending.contains_key(&request.id) {
            return Err("harness request capacity reached or duplicate request ID".into());
        }
        let (reply, receiver) = mpsc::channel();
        pending.insert(
            request.id.clone(),
            Pending {
                request,
                claimed: false,
                reply,
            },
        );
        Ok(receiver)
    }

    fn claim(&self) -> Vec<HarnessRequest> {
        let Ok(mut pending) = self.pending.lock() else {
            return vec![];
        };
        pending
            .values_mut()
            .filter_map(|entry| {
                if entry.claimed {
                    return None;
                }
                entry.claimed = true;
                Some(entry.request.clone())
            })
            .collect()
    }

    pub fn remove(&self, id: &str) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(id);
        }
    }

    fn reply(&self, id: &str, result: Result<Value, String>) {
        if let Ok(mut pending) = self.pending.lock() {
            if let Some(entry) = pending.remove(id) {
                let _ = entry.reply.send(result);
            }
        }
    }

    pub fn shutdown(&self) {
        if let Ok(mut pending) = self.pending.lock() {
            for (_, entry) in pending.drain() {
                let _ = entry.reply.send(Err("Sikemux closed".into()));
            }
        }
    }
}

pub fn execute(
    app: &tauri::AppHandle,
    broker: &HarnessBroker,
    request: HarnessRequest,
) -> Result<Value, String> {
    request.validate()?;
    let tool = tool_calls::name_of(&request);
    let result = run(app, broker, request);
    if let Some(tool) = tool {
        tool_calls::record(app, &tool, result.is_ok());
    }
    result
}

fn run(
    app: &tauri::AppHandle,
    broker: &HarnessBroker,
    mut request: HarnessRequest,
) -> Result<Value, String> {
    request.project = std::fs::canonicalize(&request.project)
        .map_err(|error| error.to_string())?
        .to_string_lossy()
        .into_owned();
    if sikemux_core::cli::protocol::is_browser_method(&request.method) {
        return crate::browser::tools::execute(app, &request);
    }
    if crate::plugins::agent::is_agent_method(&request.method) {
        return crate::plugins::agent::execute(
            app,
            &request.project,
            &request.method,
            &request.params,
        );
    }
    let id = request.id.clone();
    let method = request.method.clone();
    let inspecting = method == "workspace.inspect";
    let receiver = broker.enqueue(request)?;
    let _ = app.emit_to("main", "harness-request", ());
    let result = receiver
        .recv_timeout(REPLY_TIMEOUT)
        .unwrap_or_else(|_| Err(timeout_message(&method)));
    broker.remove(&id);
    match result {
        Ok(mut value) if inspecting => {
            if let (Some(object), Some(cli)) =
                (value.as_object_mut(), crate::cli_server::cli_command_path())
            {
                object.insert("cli".into(), cli.to_string_lossy().into());
            }
            Ok(value)
        }
        other => other,
    }
}

fn timeout_message(method: &str) -> String {
    let tool = method.replace('.', "_");
    let seconds = REPLY_TIMEOUT.as_secs();
    if method == "task.start" {
        format!("{tool} got no answer from Sikemux within {seconds} s; the task may still start. Call task_start again with the same idempotencyKey to see where it got to.")
    } else {
        format!("{tool} got no answer from Sikemux within {seconds} s. Check that the Sikemux window is open and responsive, then retry.")
    }
}

#[tauri::command]
pub fn harness_claim(state: State<'_, CliBrokerState>) -> Vec<HarnessRequest> {
    state
        .0
        .as_ref()
        .map(|broker| broker.harness().claim())
        .unwrap_or_default()
}

#[tauri::command]
pub fn harness_reply(
    state: State<'_, CliBrokerState>,
    id: String,
    result: Option<Value>,
    error: Option<String>,
) {
    if let Some(broker) = &state.0 {
        broker.harness().reply(
            &id,
            match error {
                Some(message) => Err(message),
                None => Ok(result.unwrap_or(Value::Null)),
            },
        );
    }
}

#[tauri::command]
pub async fn harness_resolve_path(project: String, path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || resolve_project_path(project, path))
        .await
        .map_err(|error| format!("harness_resolve_path join: {error}"))?
}

fn resolve_project_path(project: String, path: String) -> Result<String, String> {
    let root = std::fs::canonicalize(project).map_err(|error| error.to_string())?;
    let target = std::fs::canonicalize(root.join(path)).map_err(|error| error.to_string())?;
    if !target.starts_with(&root) || !target.is_file() {
        return Err("File must be inside the project".into());
    }
    Ok(target.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(id: &str) -> HarnessRequest {
        HarnessRequest {
            id: id.into(),
            project: "/tmp".into(),
            agent_id: None,
            method: "workspace.inspect".into(),
            params: serde_json::json!({}),
        }
    }
    #[test]
    fn queue_claims_once_replies_and_releases_capacity() {
        let broker = HarnessBroker::default();
        let receiver = broker.enqueue(request("one")).unwrap();
        assert!(broker.enqueue(request("one")).is_err());
        assert_eq!(broker.claim().len(), 1);
        assert!(broker.claim().is_empty());
        broker.reply("one", Ok(Value::Bool(true)));
        assert_eq!(receiver.recv().unwrap().unwrap(), Value::Bool(true));
        assert!(broker.enqueue(request("one")).is_ok());
        broker.shutdown();
    }
    #[test]
    fn timeouts_name_the_method_and_only_task_start_mentions_the_key() {
        let start = timeout_message("task.start");
        assert!(start.starts_with("task_start "));
        assert!(start.contains("idempotencyKey"));
        let read = timeout_message("task.read");
        assert!(read.starts_with("task_read "));
        assert!(!read.contains("idempotencyKey") && !read.contains("task_start"));
    }
    #[test]
    fn file_open_rejects_paths_outside_project() {
        let project = tempfile::tempdir().unwrap();
        let outside = tempfile::NamedTempFile::new().unwrap();
        assert!(super::resolve_project_path(
            project.path().to_string_lossy().into_owned(),
            outside.path().to_string_lossy().into_owned()
        )
        .is_err());
        let file = project.path().join("test.txt");
        std::fs::write(&file, "ok").unwrap();
        assert!(super::resolve_project_path(
            project.path().to_string_lossy().into_owned(),
            "test.txt".into()
        )
        .is_ok());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(outside.path(), project.path().join("escape")).unwrap();
            assert!(super::resolve_project_path(
                project.path().to_string_lossy().into_owned(),
                "escape".into()
            )
            .is_err());
        }
    }

    #[test]
    fn invalid_requests_and_full_queue_are_rejected() {
        let broker = HarnessBroker::default();
        let mut invalid = request("bad");
        invalid.method = "pty_kill".into();
        assert!(broker.enqueue(invalid).is_err());
        for i in 0..MAX_PENDING {
            broker.enqueue(request(&i.to_string())).unwrap();
        }
        assert!(broker.enqueue(request("overflow")).is_err());
        broker.remove("0");
        assert!(broker.enqueue(request("new")).is_ok());
    }
}

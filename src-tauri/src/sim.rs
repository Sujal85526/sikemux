//! The iOS Simulator. Devices are driven by the `sikemux-sim` helper, which
//! talks to Apple's CoreSimulator through facebook/idb's FBSimulatorControl.
//! This module starts the helper, sends it one JSON request per line and hands
//! each answer back to the caller that asked, matched by id.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::{Map, Value};
use tauri::State;
use tokio::sync::oneshot;

use crate::error::{AppError, AppResult};

/// Booting a device the first time can take most of a minute.
const BOOT_TIMEOUT: Duration = Duration::from_secs(180);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

type Reply = Result<Value, AppError>;
type Waiting = Arc<Mutex<HashMap<u64, oneshot::Sender<Reply>>>>;

struct Helper {
    child: Child,
    stdin: ChildStdin,
}

#[derive(Clone, Default)]
pub struct SimManager {
    helper: Arc<Mutex<Option<Helper>>>,
    waiting: Waiting,
    next_id: Arc<AtomicU64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SimStatus {
    supported: bool,
    reason: Option<String>,
}

impl SimManager {
    pub fn drain(&self) {
        if let Some(mut helper) = self.helper.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = helper.child.kill();
            let _ = helper.child.wait();
        }
        fail_all(&self.waiting, "Sikemux is quitting");
    }

    /// Sends one request, such as `{"type": "tap", "x": 10, "y": 20}`, and waits for its answer.
    pub async fn call(&self, request: Map<String, Value>) -> AppResult<Value> {
        let kind = request
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let id = self.next_id.fetch_add(1, Ordering::SeqCst) + 1;
        let (sender, receiver) = oneshot::channel();
        self.waiting
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id, sender);
        let mut request = request;
        request.insert("id".into(), Value::from(id));
        if let Err(error) = self.send(&Value::Object(request)) {
            self.waiting
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&id);
            return Err(error);
        }
        let timeout = if kind == "boot" {
            BOOT_TIMEOUT
        } else {
            REQUEST_TIMEOUT
        };
        match tokio::time::timeout(timeout, receiver).await {
            Ok(Ok(reply)) => reply,
            Ok(Err(_)) => Err(AppError::Other("the simulator helper stopped".into())),
            Err(_) => {
                self.waiting
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(&id);
                Err(AppError::Other(format!(
                    "the simulator did not answer `{kind}` in time"
                )))
            }
        }
    }

    fn send(&self, request: &Value) -> AppResult<()> {
        let mut slot = self.helper.lock().unwrap_or_else(|e| e.into_inner());
        let running = match slot.as_mut() {
            Some(helper) => matches!(helper.child.try_wait(), Ok(None)),
            None => false,
        };
        if !running {
            *slot = Some(self.spawn()?);
        }
        let helper = slot.as_mut().expect("helper was just started");
        let mut line = request.to_string();
        line.push('\n');
        helper
            .stdin
            .write_all(line.as_bytes())
            .and_then(|()| helper.stdin.flush())
            .map_err(|error| {
                AppError::Other(format!("simulator helper stopped listening: {error}"))
            })
    }

    fn spawn(&self) -> AppResult<Helper> {
        let executable = helper_executable().ok_or_else(|| {
            AppError::Other("the simulator helper is missing from this build".into())
        })?;
        let mut child = sikemux_process::user_environment::command(executable)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| {
                AppError::Other(format!("could not start the simulator helper: {error}"))
            })?;
        let stdin = child.stdin.take().expect("stdin is piped");
        let stdout = child.stdout.take().expect("stdout is piped");
        let waiting = Arc::clone(&self.waiting);
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if let Some((id, reply)) = parse_reply(&line) {
                    if let Some(sender) = waiting
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .remove(&id)
                    {
                        let _ = sender.send(reply);
                    }
                }
            }
            fail_all(&waiting, "the simulator helper stopped");
        });
        Ok(Helper { child, stdin })
    }
}

fn fail_all(waiting: &Waiting, message: &str) {
    for (_, sender) in waiting.lock().unwrap_or_else(|e| e.into_inner()).drain() {
        let _ = sender.send(Err(AppError::Other(message.into())));
    }
}

/// An answer from the helper: its request id, and either the result fields or the error it reported.
fn parse_reply(line: &str) -> Option<(u64, Reply)> {
    let Value::Object(mut fields) = serde_json::from_str::<Value>(line).ok()? else {
        return None;
    };
    let id = fields.remove("id")?.as_u64()?;
    match fields.remove("type")?.as_str()? {
        "result" => Some((id, Ok(Value::Object(fields)))),
        "error" => {
            let message = fields
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("the simulator failed");
            Some((id, Err(AppError::Other(message.to_owned()))))
        }
        _ => None,
    }
}

/// A helper built alongside the app, as `make dev` does.
fn helper_executable() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("SIKEMUX_SIM_EXECUTABLE") {
        return Some(PathBuf::from(path));
    }
    let beside = std::env::current_exe().ok()?.parent()?.join("sikemux-sim");
    beside.is_file().then_some(beside)
}

fn unsupported_reason() -> Option<String> {
    if !cfg!(target_os = "macos") {
        return Some("The iOS Simulator is only available on macOS.".into());
    }
    helper_executable()
        .is_none()
        .then(|| "This build does not include the simulator helper.".into())
}

#[tauri::command]
pub async fn sim_status() -> AppResult<SimStatus> {
    let reason = unsupported_reason();
    Ok(SimStatus {
        supported: reason.is_none(),
        reason,
    })
}

#[tauri::command]
pub async fn sim_call(request: Map<String, Value>, sim: State<'_, SimManager>) -> AppResult<Value> {
    if let Some(reason) = unsupported_reason() {
        return Err(AppError::Other(reason));
    }
    sim.call(request).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_result_goes_to_the_request_it_answers() {
        let (id, reply) = parse_reply(r#"{"id":7,"type":"result","pid":42}"#).unwrap();
        assert_eq!(id, 7);
        assert_eq!(reply.unwrap(), serde_json::json!({ "pid": 42 }));
    }

    #[test]
    fn an_error_carries_the_helpers_message() {
        let (id, reply) = parse_reply(r#"{"id":3,"type":"error","reason":"notBooted","message":"iPhone 17 is not running. Boot it first."}"#).unwrap();
        assert_eq!(id, 3);
        assert_eq!(
            reply.unwrap_err().to_string(),
            "iPhone 17 is not running. Boot it first."
        );
    }

    /// Drives a real simulator: `SIKEMUX_SIM_EXECUTABLE=… cargo test sim -- --ignored`.
    #[tokio::test]
    #[ignore = "needs Xcode, a simulator and a built sikemux-sim"]
    async fn the_helper_lists_boots_and_reads_a_device() {
        let sim = SimManager::default();
        let request = |value: Value| value.as_object().cloned().unwrap();
        let devices = sim
            .call(request(serde_json::json!({ "type": "devices" })))
            .await
            .unwrap();
        let udid = devices["devices"][0]["udid"].as_str().unwrap().to_owned();
        sim.call(request(serde_json::json!({ "type": "boot", "udid": udid })))
            .await
            .unwrap();
        let tree = sim
            .call(request(serde_json::json!({ "type": "tree", "udid": udid })))
            .await
            .unwrap();
        assert!(tree["elements"].is_array());
        let missing = sim
            .call(request(serde_json::json!({ "type": "tapLabel", "udid": udid, "label": "no such label anywhere" })))
            .await
            .unwrap_err();
        assert!(
            missing.to_string().contains("no such label anywhere"),
            "{missing}"
        );
        sim.drain();
    }

    #[test]
    fn lines_that_answer_no_request_are_ignored() {
        assert!(parse_reply(
            r#"{"type":"error","reason":"protocol","message":"Could not read the request"}"#
        )
        .is_none());
        assert!(parse_reply("not json").is_none());
        assert!(parse_reply(r#"{"id":1,"type":"progress"}"#).is_none());
    }
}

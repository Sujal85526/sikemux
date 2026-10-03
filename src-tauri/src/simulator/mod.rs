//! The iOS Simulator, driven by the `sikemux-sim` helper. The helper links
//! Apple's CoreSimulator through idb and answers one JSON request per line,
//! each reply carrying the id of the request it answers.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde_json::{Map, Value};

use tools::{Device, Element};

pub mod tools;
pub mod view;

const HELPER: &str = "sikemux-sim";
/// Installed by Xcode; the helper drives simulators through it.
const CORE_SIMULATOR: &str = "/Library/Developer/PrivateFrameworks/CoreSimulator.framework";

type Pending = Arc<Mutex<HashMap<u64, Sender<Result<Value, String>>>>>;

struct Helper {
    child: Child,
    stdin: ChildStdin,
    pending: Pending,
}

impl Helper {
    fn is_running(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }
}

/// The simulator an agent attached, and the elements of its latest read, which
/// the agent's element numbers refer to.
struct Attachment {
    device: Device,
    elements: Vec<Element>,
}

pub struct SimulatorManager {
    executable: Option<PathBuf>,
    /// Where the helper published with this release is kept once downloaded.
    downloaded: Option<PathBuf>,
    helper: Mutex<Option<Helper>>,
    next_id: AtomicU64,
    attachments: Mutex<HashMap<String, Attachment>>,
}

impl Default for SimulatorManager {
    fn default() -> Self {
        Self::with_executable(helper_executable())
    }
}

impl SimulatorManager {
    /// Runs the helper beside the app when a dev build put one there, and
    /// otherwise the one published with this release, kept in `data_dir`.
    pub fn for_app(data_dir: &Path) -> Self {
        let local = helper_executable();
        let downloaded = (local.is_none() && published().is_some()).then(|| data_dir.join(HELPER));
        Self {
            downloaded,
            ..Self::with_executable(local)
        }
    }

    /// Downloads the published helper if this Mac can run simulators and it is
    /// not already here, so it is ready before an agent or the person needs it.
    pub async fn prepare(&self) -> Result<(), String> {
        let (Some(path), Some(helper)) = (&self.downloaded, published()) else {
            return Ok(());
        };
        if !Path::new(CORE_SIMULATOR).exists()
            || crate::voice_models::release_file_matches(path, helper.size, helper.sha256)
        {
            return Ok(());
        }
        crate::voice_models::fetch_release_executable(
            helper.asset,
            path,
            helper.size,
            helper.sha256,
        )
        .await
        .map_err(|error| format!("could not download the iOS Simulator helper: {error}"))
    }

    /// Where the helper this app runs comes from, for Settings to show.
    pub fn helper_state(&self) -> &'static str {
        match (&self.executable, &self.downloaded, published()) {
            (Some(_), _, _) => "built with this copy of Sikemux",
            (None, Some(path), Some(helper))
                if crate::voice_models::release_file_matches(path, helper.size, helper.sha256) =>
            {
                "ready"
            }
            (None, Some(_), Some(_)) => "downloading",
            _ => "not included in this build",
        }
    }

    pub fn with_executable(executable: Option<PathBuf>) -> Self {
        Self {
            executable,
            downloaded: None,
            helper: Mutex::new(None),
            next_id: AtomicU64::new(1),
            attachments: Mutex::default(),
        }
    }

    fn attach(&self, agent_id: &str, device: Device) {
        self.lock_attachments().insert(
            agent_id.to_owned(),
            Attachment {
                device,
                elements: Vec::new(),
            },
        );
    }

    fn attached(&self, agent_id: &str) -> Option<Device> {
        self.lock_attachments()
            .get(agent_id)
            .map(|attachment| attachment.device.clone())
    }

    fn remember_elements(&self, agent_id: &str, elements: Vec<Element>) {
        if let Some(attachment) = self.lock_attachments().get_mut(agent_id) {
            attachment.elements = elements;
        }
    }

    fn elements(&self, agent_id: &str) -> Vec<Element> {
        self.lock_attachments()
            .get(agent_id)
            .map(|attachment| attachment.elements.clone())
            .unwrap_or_default()
    }

    fn lock_attachments(&self) -> MutexGuard<'_, HashMap<String, Attachment>> {
        self.attachments
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Sends `{"type": kind, ...fields}` and waits for its reply. Requests from
    /// several threads run side by side in the helper.
    pub fn request(&self, kind: &str, fields: Value, timeout: Duration) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let mut line = match fields {
            Value::Object(map) => map,
            Value::Null => Map::new(),
            _ => return Err("simulator request fields must be an object".into()),
        };
        line.insert("id".into(), id.into());
        line.insert("type".into(), kind.into());
        let mut line = Value::Object(line).to_string();
        line.push('\n');

        let (reply, answer) = mpsc::channel();
        let pending = {
            let mut slot = self.lock();
            let helper = self.running(&mut slot)?;
            helper
                .pending
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .insert(id, reply);
            let sent = helper
                .stdin
                .write_all(line.as_bytes())
                .and_then(|()| helper.stdin.flush());
            if let Err(error) = sent {
                helper
                    .pending
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .remove(&id);
                return Err(format!("the simulator helper stopped listening: {error}"));
            }
            Arc::clone(&helper.pending)
        };
        match answer.recv_timeout(timeout) {
            Ok(result) => result,
            Err(RecvTimeoutError::Timeout) => {
                pending
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .remove(&id);
                Err(format!(
                    "the simulator did not answer {kind} within {} s",
                    timeout.as_secs()
                ))
            }
            Err(RecvTimeoutError::Disconnected) => Err("the simulator helper stopped".into()),
        }
    }

    pub fn drain(&self) {
        if let Some(mut helper) = self.lock().take() {
            let _ = helper.child.kill();
            let _ = helper.child.wait();
        }
    }

    fn lock(&self) -> MutexGuard<'_, Option<Helper>> {
        self.helper
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn running<'a>(&self, slot: &'a mut Option<Helper>) -> Result<&'a mut Helper, String> {
        if !slot.as_mut().is_some_and(Helper::is_running) {
            *slot = Some(self.spawn()?);
        }
        Ok(slot.as_mut().expect("helper was just started"))
    }

    fn spawn(&self) -> Result<Helper, String> {
        let executable = runnable(
            self.executable.as_deref(),
            self.downloaded.as_deref(),
            published().as_ref(),
            |path, helper| {
                crate::voice_models::release_file_matches(path, helper.size, helper.sha256)
            },
        )?;
        let mut child = sikemux_process::user_environment::command(executable)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|error| format!("could not start the simulator helper: {error}"))?;
        let stdin = child.stdin.take().expect("stdin is piped");
        let stdout = child.stdout.take().expect("stdout is piped");
        let pending: Pending = Arc::default();
        let replies = Arc::clone(&pending);
        std::thread::Builder::new()
            .name("sikemux-sim-replies".into())
            .spawn(move || read_replies(BufReader::new(stdout), &replies))
            .map_err(|error| format!("could not read the simulator helper: {error}"))?;
        Ok(Helper {
            child,
            stdin,
            pending,
        })
    }
}

/// Hands each reply to whoever sent its request. When the helper says it cannot
/// reach CoreSimulator, or exits, everyone still waiting is told why.
fn read_replies(stdout: impl BufRead, pending: &Pending) {
    let mut gone = String::from("the simulator helper stopped");
    for line in stdout.lines() {
        let Ok(line) = line else { break };
        let Ok(reply) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if reply.get("type").and_then(Value::as_str) == Some("unavailable") {
            if let Some(message) = reply.get("message").and_then(Value::as_str) {
                gone = message.to_owned();
            }
            continue;
        }
        let Some(id) = reply.get("id").and_then(Value::as_u64) else {
            continue;
        };
        let Some(sender) = pending
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&id)
        else {
            continue;
        };
        let result = if reply.get("ok").and_then(Value::as_bool) == Some(true) {
            Ok(reply.get("result").cloned().unwrap_or(Value::Null))
        } else {
            Err(reply
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("the simulator helper failed without saying why")
                .to_owned())
        };
        let _ = sender.send(result);
    }
    for (_, sender) in pending.lock().unwrap_or_else(|p| p.into_inner()).drain() {
        let _ = sender.send(Err(gone.clone()));
    }
}

/// The person's switch for the simulator in Settings, on until they turn it off.
static ENABLED: AtomicBool = AtomicBool::new(true);

pub fn set_enabled(enabled: bool) {
    ENABLED.store(enabled, Ordering::Relaxed);
}

/// Whether agents are offered the simulator tools: the person has not turned
/// them off, and this Mac can run simulators.
pub fn offered() -> bool {
    ENABLED.load(Ordering::Relaxed) && capable()
}

/// Whether this Mac can run simulators at all, whatever the switch says.
pub fn capable() -> bool {
    (helper_executable().is_some() || published().is_some()) && Path::new(CORE_SIMULATOR).exists()
}

/// The helper to run: one beside a dev build, else the published one once the
/// download is in place and is that exact file.
fn runnable<'a>(
    local: Option<&'a Path>,
    downloaded: Option<&'a Path>,
    published: Option<&Published>,
    matches: impl Fn(&Path, &Published) -> bool,
) -> Result<&'a Path, String> {
    match (local, downloaded, published) {
        (Some(local), _, _) => Ok(local),
        (None, Some(path), Some(helper)) if matches(path, helper) => Ok(path),
        (None, Some(_), Some(_)) => {
            Err("the iOS Simulator helper is still downloading; try again in a moment".into())
        }
        _ => Err("this build of Sikemux does not include the iOS Simulator helper".into()),
    }
}

/// The helper published beside this release; the build accepts only that exact file.
struct Published {
    asset: &'static str,
    size: u64,
    sha256: &'static str,
}

fn published() -> Option<Published> {
    Some(Published {
        asset: option_env!("SIKEMUX_SIM_HELPER_ASSET")?,
        size: option_env!("SIKEMUX_SIM_HELPER_SIZE")?.parse().ok()?,
        sha256: option_env!("SIKEMUX_SIM_HELPER_SHA256")?,
    })
}

/// A helper built beside the app, as `pnpm build:sim --dev` does.
fn helper_executable() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("SIKEMUX_SIM_EXECUTABLE") {
        return Some(PathBuf::from(path));
    }
    let beside = std::env::current_exe().ok()?.parent()?.join(HELPER);
    beside.is_file().then_some(beside)
}

#[cfg(test)]
mod tests;

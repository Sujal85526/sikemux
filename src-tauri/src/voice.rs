//! Push-to-talk dictation. Speech is recorded and transcribed by the bundled
//! `sikemux-voice` helper, which runs NVIDIA Parakeet on the Neural Engine.
//! This module starts the helper, forwards commands to it as JSON lines, and
//! relays everything it reports to the window as `voice` events.

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::error::{AppError, AppResult};

pub const VOICE_EVENT: &str = "voice";
const READY_MARKER: &str = "parakeet-v3.ready";

struct Helper {
    child: Child,
    stdin: ChildStdin,
    stopped_on_purpose: Arc<AtomicBool>,
}

#[derive(Clone, Default)]
pub struct VoiceManager {
    helper: Arc<Mutex<Option<Helper>>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStatus {
    supported: bool,
    installed: bool,
    reason: Option<String>,
}

impl VoiceManager {
    pub fn drain(&self) {
        if let Some(mut helper) = self.lock().take() {
            helper.stopped_on_purpose.store(true, Ordering::SeqCst);
            let _ = helper.child.kill();
            let _ = helper.child.wait();
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Option<Helper>> {
        self.helper
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn send(&self, app: &AppHandle, command: Value) -> AppResult<()> {
        let mut slot = self.lock();
        let running = match slot.as_mut() {
            Some(helper) => matches!(helper.child.try_wait(), Ok(None)),
            None => false,
        };
        if !running {
            *slot = Some(self.spawn(app)?);
        }
        let helper = slot.as_mut().expect("helper was just started");
        let mut line = command.to_string();
        line.push('\n');
        helper
            .stdin
            .write_all(line.as_bytes())
            .and_then(|()| helper.stdin.flush())
            .map_err(|error| AppError::Other(format!("voice helper stopped listening: {error}")))
    }

    fn spawn(&self, app: &AppHandle) -> AppResult<Helper> {
        let executable = helper_executable()
            .ok_or_else(|| AppError::Other("the voice helper is missing from this build".into()))?;
        let marker = models_dir(app)?.join(READY_MARKER);
        let mut child = Command::new(executable)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|error| {
                AppError::Other(format!("could not start the voice helper: {error}"))
            })?;
        let stdin = child.stdin.take().expect("stdin is piped");
        let stdout = child.stdout.take().expect("stdout is piped");
        let app = app.clone();
        let stopped_on_purpose = Arc::new(AtomicBool::new(false));
        let stopped = Arc::clone(&stopped_on_purpose);
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                let Ok(event) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if event["type"] == "ready" {
                    let _ = std::fs::write(&marker, b"");
                }
                let _ = app.emit_to("main", VOICE_EVENT, event);
            }
            if !stopped.load(Ordering::SeqCst) {
                let _ = app.emit_to("main", VOICE_EVENT, json!({ "type": "exited" }));
            }
        });
        Ok(Helper {
            child,
            stdin,
            stopped_on_purpose,
        })
    }
}

fn helper_executable() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("SIKEMUX_VOICE_EXECUTABLE") {
        return Some(PathBuf::from(path));
    }
    let bundled = std::env::current_exe()
        .ok()?
        .parent()?
        .join("sikemux-voice");
    bundled.is_file().then_some(bundled)
}

fn models_dir(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| AppError::Other(format!("voice data directory unavailable: {error}")))?
        .join("voice"))
}

#[cfg(target_os = "macos")]
fn unsupported_reason() -> Option<String> {
    use objc2_foundation::{NSOperatingSystemVersion, NSProcessInfo};
    let minimum = NSOperatingSystemVersion {
        majorVersion: 14,
        minorVersion: 0,
        patchVersion: 0,
    };
    if !NSProcessInfo::processInfo().isOperatingSystemAtLeastVersion(minimum) {
        return Some("Dictation needs macOS 14 or later.".into());
    }
    helper_executable()
        .is_none()
        .then(|| "This build does not include the voice helper.".into())
}

#[cfg(not(target_os = "macos"))]
fn unsupported_reason() -> Option<String> {
    Some("Dictation is only available on macOS.".into())
}

#[tauri::command]
pub async fn voice_status(app: AppHandle) -> AppResult<VoiceStatus> {
    let reason = unsupported_reason();
    Ok(VoiceStatus {
        supported: reason.is_none(),
        installed: models_dir(&app)?.join(READY_MARKER).is_file(),
        reason,
    })
}

#[tauri::command]
pub async fn voice_prepare(app: AppHandle, voice: State<'_, VoiceManager>) -> AppResult<()> {
    if let Some(reason) = unsupported_reason() {
        return Err(AppError::Other(reason));
    }
    let dir = models_dir(&app)?;
    std::fs::create_dir_all(&dir)?;
    voice.send(
        &app,
        json!({ "type": "prepare", "modelsDir": dir.to_string_lossy() }),
    )
}

#[tauri::command]
pub async fn voice_start(
    app: AppHandle,
    voice: State<'_, VoiceManager>,
    vocabulary: Vec<String>,
) -> AppResult<()> {
    voice.send(&app, json!({ "type": "start", "vocabulary": vocabulary }))
}

#[tauri::command]
pub async fn voice_stop(app: AppHandle, voice: State<'_, VoiceManager>) -> AppResult<()> {
    voice.send(&app, json!({ "type": "stop" }))
}

#[tauri::command]
pub async fn voice_shutdown(voice: State<'_, VoiceManager>) -> AppResult<()> {
    voice.drain();
    Ok(())
}

#[tauri::command]
pub async fn voice_cancel(app: AppHandle, voice: State<'_, VoiceManager>) -> AppResult<()> {
    voice.send(&app, json!({ "type": "cancel" }))
}

//! What agents and the desk do with a simulator: which device each agent has
//! attached, how it was last read and which way it is turned. Requests go to
//! the `sikemux-sim` helper through [`crate::sim::SimManager`].

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter, State};

use crate::sim::SimManager;
use tools::{Device, Element};

pub mod tools;

const CORE_SIMULATOR: &str = "/Library/Developer/PrivateFrameworks/CoreSimulator.framework";

struct Attachment {
    device: Device,
    project: String,
    read: Option<(String, Vec<Element>)>,
}

/// One agent's device, as the desk lists it.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentInfo {
    pub agent_id: String,
    pub udid: String,
    pub name: String,
    pub project: String,
}

/// Where the helper comes from: the app's own, downloaded if it must be, or a given one in tests.
enum Helper {
    App(AppHandle),
    #[cfg_attr(not(test), allow(dead_code))]
    At(PathBuf),
}

pub struct SimulatorManager {
    sim: SimManager,
    helper: Helper,
    attachments: Mutex<HashMap<String, Attachment>>,
    /// The device the person picked on an agent's desk before the agent attached one.
    desk: Mutex<HashMap<String, String>>,
    orientations: Mutex<HashMap<String, String>>,
}

impl SimulatorManager {
    pub fn for_app(app: AppHandle, sim: SimManager) -> Self {
        Self::new(sim, Helper::App(app))
    }

    #[cfg(test)]
    pub(crate) fn with_helper(path: PathBuf) -> Self {
        Self::new(SimManager::default(), Helper::At(path))
    }

    fn new(sim: SimManager, helper: Helper) -> Self {
        Self {
            sim,
            helper,
            attachments: Mutex::default(),
            desk: Mutex::default(),
            orientations: Mutex::default(),
        }
    }

    /// Sends `kind` with `fields`, such as `tap` with `{"udid": …, "x": 10, "y": 20}`.
    pub async fn request(&self, kind: &str, fields: Value) -> Result<Value, String> {
        let mut request = match fields {
            Value::Object(map) => map,
            Value::Null => Map::new(),
            _ => return Err("simulator request fields must be an object".into()),
        };
        request.insert("type".into(), kind.into());
        let executable = match &self.helper {
            Helper::App(app) => crate::sim::executable(app)
                .await
                .map_err(|error| error.to_string())?,
            Helper::At(path) => path.clone(),
        };
        self.sim
            .call(executable, request)
            .await
            .map_err(|error| error.to_string())
    }

    fn detach(&self, agent_id: &str) -> Option<Device> {
        self.lock_attachments()
            .remove(agent_id)
            .map(|attachment| attachment.device)
    }

    fn attach(&self, agent_id: &str, project: &str, device: Device) {
        self.lock_attachments().insert(
            agent_id.to_owned(),
            Attachment {
                device,
                project: project.to_owned(),
                read: None,
            },
        );
    }

    pub fn attachments(&self) -> Vec<AttachmentInfo> {
        let mut listed: Vec<AttachmentInfo> = self
            .lock_attachments()
            .iter()
            .map(|(agent_id, attachment)| AttachmentInfo {
                agent_id: agent_id.clone(),
                udid: attachment.device.udid.clone(),
                name: attachment.device.name.clone(),
                project: attachment.project.clone(),
            })
            .collect();
        listed.sort_by(|a, b| a.agent_id.cmp(&b.agent_id));
        listed
    }

    /// Whatever was booted outside an agent's own calls, such as from a desk tab.
    pub fn note_booted(&self, _udid: &str) {}

    fn desk_device(&self, agent_id: &str) -> Option<String> {
        self.desk
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(agent_id)
            .cloned()
    }

    fn attached(&self, agent_id: &str) -> Option<Device> {
        self.lock_attachments()
            .get(agent_id)
            .map(|attachment| attachment.device.clone())
    }

    fn remember_read(&self, agent_id: &str, app: String, elements: Vec<Element>) {
        if let Some(attachment) = self.lock_attachments().get_mut(agent_id) {
            attachment.read = Some((app, elements));
        }
    }

    fn set_orientation(&self, udid: &str, orientation: &str) {
        self.orientations
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(udid.to_owned(), orientation.to_owned());
    }

    fn screen_for(&self, device: &Device) -> Option<(f64, f64)> {
        let (width, height) = device.screen?;
        let sideways = self
            .orientations
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(&device.udid)
            .is_some_and(|orientation| orientation.starts_with("landscape"));
        Some(if sideways {
            (height, width)
        } else {
            (width, height)
        })
    }

    fn last_read(&self, agent_id: &str) -> Option<(String, Vec<Element>)> {
        self.lock_attachments().get(agent_id)?.read.clone()
    }

    fn elements(&self, agent_id: &str) -> Vec<Element> {
        self.last_read(agent_id)
            .map(|(_, elements)| elements)
            .unwrap_or_default()
    }

    fn lock_attachments(&self) -> MutexGuard<'_, HashMap<String, Attachment>> {
        self.attachments
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

static ENABLED: AtomicBool = AtomicBool::new(true);

pub fn set_enabled(enabled: bool) {
    ENABLED.store(enabled, Ordering::Relaxed);
}

/// Whether agents are offered the `sim_*` tools: the person has not turned them
/// off, and this Mac can run simulators.
pub fn offered() -> bool {
    ENABLED.load(Ordering::Relaxed) && capable()
}

/// This Mac can run the helper and Xcode's simulators.
pub fn capable() -> bool {
    unsupported_reason().is_none()
}

/// The oldest macOS the helper runs on.
const MINIMUM_MACOS: u32 = 15;
/// Checking runs `xcode-select`, so an answer is kept this long.
const RECHECK: Duration = Duration::from_secs(30);

/// Why this Mac cannot run the simulator, or nothing when it can.
pub fn unsupported_reason() -> Option<String> {
    static CHECKED: Mutex<Option<(Instant, Option<String>)>> = Mutex::new(None);
    let mut checked = CHECKED
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some((at, reason)) = checked.as_ref() {
        if at.elapsed() < RECHECK {
            return reason.clone();
        }
    }
    let reason = check_support();
    *checked = Some((Instant::now(), reason.clone()));
    reason
}

fn check_support() -> Option<String> {
    if !cfg!(target_os = "macos") {
        return Some("The iOS Simulator is only available on macOS.".into());
    }
    if macos_major().is_some_and(|major| major < MINIMUM_MACOS) {
        return Some(format!(
            "The iOS Simulator needs macOS {MINIMUM_MACOS} or later."
        ));
    }
    if crate::sim::local_helper().is_none() && crate::sim::published_helper().is_none() {
        return Some("This build does not include the simulator helper.".into());
    }
    if developer_dir().is_none() {
        return Some(if Path::new(COMMAND_LINE_TOOLS).exists() {
            "The iOS Simulator needs Xcode, and only Apple's Command Line Tools are installed. Install Xcode from the App Store and open it once.".into()
        } else {
            "The iOS Simulator needs Xcode. Install it from the App Store and open it once.".into()
        });
    }
    if !Path::new(CORE_SIMULATOR).exists() {
        return Some(
            "Xcode's simulators are not set up yet. Open Xcode once to finish installing them."
                .into(),
        );
    }
    None
}

const COMMAND_LINE_TOOLS: &str = "/Library/Developer/CommandLineTools";

fn macos_major() -> Option<u32> {
    let plist = std::fs::read_to_string("/System/Library/CoreServices/SystemVersion.plist").ok()?;
    let after = plist.split("<key>ProductVersion</key>").nth(1)?;
    let version = after.split("<string>").nth(1)?.split("</string>").next()?;
    version.split('.').next()?.trim().parse().ok()
}

/// A full Xcode's developer directory: the one `xcode-select` chose, or else
/// one in /Applications. The Command Line Tools alone have no simulators.
pub(crate) fn developer_dir() -> Option<PathBuf> {
    let full = |dir: &Path| dir.join("usr/bin/simctl").is_file();
    let selected = std::env::var_os("DEVELOPER_DIR")
        .map(PathBuf::from)
        .or_else(|| {
            sikemux_process::user_environment::command("/usr/bin/xcode-select")
                .arg("-p")
                .stdin(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .output()
                .ok()
                .filter(|output| output.status.success())
                .map(|output| PathBuf::from(String::from_utf8_lossy(&output.stdout).trim()))
        });
    if let Some(selected) = selected.filter(|dir| full(dir)) {
        return Some(selected);
    }
    let mut installed: Vec<PathBuf> = std::fs::read_dir("/Applications")
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("Xcode") && name.ends_with(".app"))
        })
        .map(|app| app.join("Contents/Developer"))
        .filter(|dir| full(dir))
        .collect();
    installed.sort();
    installed.into_iter().next()
}

/// Every agent's device, for the desk's device picker and an agent's tab.
#[tauri::command]
pub fn simulator_attachments(manager: State<'_, SimulatorManager>) -> Vec<AttachmentInfo> {
    manager.attachments()
}

/// The person picked `udid` on this agent's desk. An attached agent moves to
/// it now; one that has not attached yet is given it when it does.
#[tauri::command]
pub async fn simulator_set_desk_device(
    app: AppHandle,
    manager: State<'_, SimulatorManager>,
    agent_id: String,
    udid: String,
) -> Result<(), String> {
    manager
        .desk
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(agent_id.clone(), udid.clone());
    if manager.attached(&agent_id).is_none() {
        return Ok(());
    }
    let devices = tools::list_devices(&manager).await?;
    let device = devices
        .into_iter()
        .find(|device| device.udid == udid)
        .ok_or_else(|| format!("no simulator has the id {udid}"))?;
    if let Some(attachment) = manager.lock_attachments().get_mut(&agent_id) {
        attachment.device = device.clone();
        attachment.read = None;
    }
    let _ = app.emit_to(
        "main",
        tools::ATTACHED_EVENT,
        json!({ "agentId": agent_id, "udid": device.udid, "name": device.name }),
    );
    Ok(())
}

#[tauri::command]
pub fn simulator_set_enabled(enabled: bool) {
    set_enabled(enabled);
}

/// What Settings shows about the simulator: the Xcode in use, its iOS runtimes,
/// and where the helper stands.
#[tauri::command]
pub async fn simulator_setup(app: AppHandle) -> Value {
    let (xcode, runtimes) = tauri::async_runtime::spawn_blocking(|| {
        let Some(dir) = developer_dir() else {
            let tools_only = Path::new(COMMAND_LINE_TOOLS).exists().then(|| {
                format!("{COMMAND_LINE_TOOLS} (Command Line Tools only; the simulator needs Xcode)")
            });
            return (tools_only, Vec::new());
        };
        let runtimes = simctl(&dir, &["list", "runtimes", "--json"])
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .map(|list| {
                list["runtimes"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|runtime| runtime["isAvailable"].as_bool() == Some(true))
                    .filter_map(|runtime| runtime["name"].as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default();
        (Some(dir.to_string_lossy().into_owned()), runtimes)
    })
    .await
    .unwrap_or_default();
    let helper = if crate::sim::local_helper().is_some() {
        "built with this copy of Sikemux"
    } else if crate::sim::installed(&app) {
        "ready"
    } else if crate::sim::published_helper().is_some() {
        "downloaded when first needed"
    } else {
        "not included in this build"
    };
    json!({
        "xcode": xcode,
        "runtimes": runtimes,
        "helper": helper,
    })
}

/// Runs Xcode's `simctl` from a full Xcode, never through `xcrun`, which offers
/// to install the developer tools on a Mac without them.
pub(crate) fn simctl(developer_dir: &Path, args: &[&str]) -> Option<String> {
    sikemux_process::user_environment::command(developer_dir.join("usr/bin/simctl"))
        .args(args)
        .env("DEVELOPER_DIR", developer_dir)
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

#[cfg(test)]
mod tests;

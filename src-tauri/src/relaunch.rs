//! Agents keep running in the core while an update restarts the app. What they
//! had open in the app itself, their browser tabs and simulators, is written
//! down as the old app quits and read back once as the new one starts.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::browser::{BrowserManager, SavedStrip};
use crate::simulator::{SavedSimulators, SimulatorManager};

/// Older than this, the save is from some earlier restart that never came back.
const FRESH_FOR: Duration = Duration::from_secs(5 * 60);

static UPDATE_INSTALLED: AtomicBool = AtomicBool::new(false);
static RESTARTING: AtomicBool = AtomicBool::new(false);

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Handover {
    saved_at: u64,
    browser: Vec<SavedStrip>,
    simulators: SavedSimulators,
}

pub fn note_update_installed() {
    UPDATE_INSTALLED.store(true, Ordering::Release);
}

pub fn note_exit_requested(code: Option<i32>) {
    if code == Some(tauri::RESTART_EXIT_CODE) {
        RESTARTING.store(true, Ordering::Release);
    }
}

/// The app is quitting to start the update it just installed.
pub fn for_update() -> bool {
    UPDATE_INSTALLED.load(Ordering::Acquire) && RESTARTING.load(Ordering::Acquire)
}

fn path(app: &AppHandle) -> Option<PathBuf> {
    Some(app.path().app_data_dir().ok()?.join("update-handover.json"))
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_secs())
}

pub fn save(app: &AppHandle) {
    let Some(path) = path(app) else { return };
    let handover = Handover {
        saved_at: now(),
        browser: app
            .try_state::<BrowserManager>()
            .map(|browser| browser.saved_strips())
            .unwrap_or_default(),
        simulators: app
            .try_state::<SimulatorManager>()
            .map(|simulators| simulators.saved())
            .unwrap_or_default(),
    };
    let written = serde_json::to_vec(&handover)
        .map_err(std::io::Error::from)
        .and_then(|bytes| {
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir)?;
            }
            std::fs::write(&path, bytes)
        });
    if let Err(error) = written {
        eprintln!("Sikemux could not save agents' tabs and simulators for the update: {error}");
    }
}

pub fn restore(app: &AppHandle) {
    let Some(path) = path(app) else { return };
    let Ok(bytes) = std::fs::read(&path) else {
        return;
    };
    let _ = std::fs::remove_file(&path);
    let Ok(handover) = serde_json::from_slice::<Handover>(&bytes) else {
        return;
    };
    if now().saturating_sub(handover.saved_at) > FRESH_FOR.as_secs() {
        return;
    }
    if let Some(browser) = app.try_state::<BrowserManager>() {
        browser.reopen(app, handover.browser);
    }
    if let Some(simulators) = app.try_state::<SimulatorManager>() {
        simulators.restore(handover.simulators);
    }
}

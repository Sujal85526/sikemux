use std::fs;
use std::path::PathBuf;

use crate::error::{AppError, AppResult};

/// Where the workspace state JSON lives. Split debug vs release so a dev
/// build can never trample the installed app's state — `cargo run` /
/// `tauri dev` write to `state.dev.json`, the bundled release binary
/// writes to `state.json`. They live in the same dir so the user can
/// `cp` between them when seeding dev from a real session.
///
/// `cfg!(debug_assertions)` is the discriminator: true for any cargo debug
/// build (which is what `tauri dev` produces), false for `--release`
/// builds (which is what `tauri build` produces). Reliable enough that we
/// don't need an env-var override.
pub fn state_path() -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    let filename = if cfg!(debug_assertions) {
        "state.dev.json"
    } else {
        "state.json"
    };
    Some(PathBuf::from(home).join(".config/sikemux").join(filename))
}

/// Persisted workspace state as a JSON string. Empty string if none yet.
#[tauri::command]
pub fn state_load() -> String {
    state_path()
        .and_then(|p| fs::read_to_string(p).ok())
        .unwrap_or_default()
}

#[tauri::command]
pub async fn state_save(data: String) -> AppResult<()> {
    tauri::async_runtime::spawn_blocking(move || state_save_sync(data))
        .await
        .map_err(|e| AppError::Other(format!("state_save join: {e}")))?
}

fn state_save_sync(data: String) -> AppResult<()> {
    let path = state_path().ok_or(AppError::State("no home directory".into()))?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    fs::write(&path, data).map_err(AppError::from)
}

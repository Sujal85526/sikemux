use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use crate::error::{AppError, AppResult};

const MAX_STATE_BYTES: u64 = 32 * 1024 * 1024;

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
    let Some(path) = state_path() else {
        return String::new();
    };
    read_valid_json(&path)
        .or_else(|| read_valid_json(&backup_path(&path)))
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
    if data.len() as u64 > MAX_STATE_BYTES {
        return Err(AppError::State(
            "state snapshot exceeds 32 MiB limit".into(),
        ));
    }
    serde_json::from_str::<serde_json::Value>(&data)
        .map_err(|e| AppError::State(format!("refusing to persist invalid JSON: {e}")))?;

    if let Some(previous) = read_valid_json(&path) {
        write_atomic(&backup_path(&path), previous.as_bytes())?;
    }
    write_atomic(&path, data.as_bytes())
}

fn backup_path(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(".bak");
    PathBuf::from(name)
}

fn read_valid_json(path: &Path) -> Option<String> {
    let file = fs::File::open(path).ok()?;
    let mut bytes = Vec::new();
    file.take(MAX_STATE_BYTES + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > MAX_STATE_BYTES {
        return None;
    }
    let data = String::from_utf8(bytes).ok()?;
    serde_json::from_str::<serde_json::Value>(&data).ok()?;
    Some(data)
}

fn write_atomic(path: &Path, data: &[u8]) -> AppResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| AppError::State("invalid state path".into()))?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        temp.as_file()
            .set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    temp.write_all(data)?;
    temp.flush()?;
    temp.as_file().sync_all()?;
    temp.persist(path).map_err(|e| AppError::from(e.error))?;
    fs::File::open(parent)?.sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomic_state_write_replaces_content_and_keeps_valid_json() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        write_atomic(&path, br#"{"version":1}"#).unwrap();
        write_atomic(&path, br#"{"version":2}"#).unwrap();
        assert_eq!(read_valid_json(&path).as_deref(), Some(r#"{"version":2}"#));
    }

    #[test]
    fn invalid_primary_can_fall_back_to_backup() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        fs::write(&path, "{").unwrap();
        fs::write(backup_path(&path), r#"{"version":1}"#).unwrap();
        assert!(read_valid_json(&path).is_none());
        assert!(read_valid_json(&backup_path(&path)).is_some());
    }
}

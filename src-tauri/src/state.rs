use std::fs;
use std::path::PathBuf;

fn state_path() -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    Some(PathBuf::from(home).join(".config/sikemux/state.json"))
}

/// Persisted workspace state as a JSON string. Empty string if none yet.
#[tauri::command]
pub fn state_load() -> String {
    state_path()
        .and_then(|p| fs::read_to_string(p).ok())
        .unwrap_or_default()
}

#[tauri::command]
pub fn state_save(data: String) -> Result<(), String> {
    let path = state_path().ok_or("no home directory")?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    fs::write(&path, data).map_err(|e| e.to_string())
}

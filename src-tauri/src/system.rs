use std::fs;
use std::path::PathBuf;
use std::process::Command;

use serde::Serialize;

#[tauri::command]
pub fn home_dir() -> String {
    std::env::var("HOME").unwrap_or_default()
}

/// Frecency-ranked directories from zoxide, for the sesh picker.
#[tauri::command]
pub fn recent_dirs() -> Vec<String> {
    zoxide_dirs()
}

fn zoxide_dirs() -> Vec<String> {
    for bin in ["zoxide", "/opt/homebrew/bin/zoxide", "/usr/local/bin/zoxide"] {
        if let Ok(out) = Command::new(bin).args(["query", "--list"]).output() {
            if out.status.success() {
                return String::from_utf8_lossy(&out.stdout)
                    .lines()
                    .map(|l| l.trim().to_string())
                    .filter(|l| !l.is_empty())
                    .collect();
            }
        }
    }
    Vec::new()
}

#[derive(Serialize)]
pub struct BootInfo {
    home: String,
    state: String,
    recent: Vec<String>,
}

/// Single round-trip the renderer uses on boot — home dir + persisted state
/// + zoxide recents in one IPC instead of three.
#[tauri::command]
pub fn boot_init() -> BootInfo {
    let home = home_dir();
    let state = if home.is_empty() {
        String::new()
    } else {
        fs::read_to_string(PathBuf::from(&home).join(".config/sikemux/state.json"))
            .unwrap_or_default()
    };
    BootInfo {
        home,
        state,
        recent: zoxide_dirs(),
    }
}

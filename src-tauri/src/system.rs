use std::fs;
use std::process::Command;

use serde::Serialize;

use crate::state::state_path;

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

// ---- Battery -------------------------------------------------------------

#[derive(Serialize, Clone)]
pub struct BatteryStatus {
    /// 0..100, or None when there's no battery (desktop, external display).
    pub percent: Option<u8>,
    pub charging: bool,
    /// Free-form remaining time string from `pmset` (e.g. "4:23"), if any.
    pub time_remaining: Option<String>,
}

/// macOS battery via `pmset -g batt`. Cheap (sub-ms), polled by the TopBar.
/// Returns percent=None on machines without a battery so the chip hides
/// cleanly. Same approach as the user's existing `tmux-battery` script.
#[tauri::command]
pub fn battery_status() -> BatteryStatus {
    #[cfg(not(target_os = "macos"))]
    {
        return BatteryStatus { percent: None, charging: false, time_remaining: None };
    }
    #[cfg(target_os = "macos")]
    {
        let out = match Command::new("pmset").args(["-g", "batt"]).output() {
            Ok(o) if o.status.success() => o,
            _ => return BatteryStatus { percent: None, charging: false, time_remaining: None },
        };
        parse_pmset(&String::from_utf8_lossy(&out.stdout))
    }
}

#[cfg(target_os = "macos")]
fn parse_pmset(text: &str) -> BatteryStatus {
    // Format:
    //   Now drawing from 'AC Power' | 'Battery Power'
    //    -InternalBattery-0 (id=...)  87%; <state>; <time> remaining present: true
    // <state> ∈ {charging, discharging, charged, finishing charge, AC attached, ...}
    let mut percent: Option<u8> = None;
    let mut charging = false;
    let mut time_remaining: Option<String> = None;
    let drawing_from_ac = text.contains("'AC Power'");
    for line in text.lines() {
        let line = line.trim();
        if !line.contains("InternalBattery") {
            continue;
        }
        // Percent: first "<n>%" token.
        if let Some(pct_end) = line.find('%') {
            let start = line[..pct_end]
                .rfind(|c: char| !c.is_ascii_digit())
                .map(|i| i + 1)
                .unwrap_or(0);
            if let Ok(n) = line[start..pct_end].parse::<u8>() {
                percent = Some(n);
            }
        }
        let lower = line.to_lowercase();
        if lower.contains("charging") && !lower.contains("discharging") {
            charging = true;
        } else if lower.contains("charged") || lower.contains("finishing charge") {
            charging = drawing_from_ac;
        } else if drawing_from_ac {
            charging = true;
        }
        // Time remaining: "H:MM remaining"
        if let Some(idx) = lower.find(" remaining") {
            let head = &line[..idx];
            if let Some(last_space) = head.rfind(char::is_whitespace) {
                let candidate = head[last_space + 1..].trim();
                if candidate.contains(':') && !candidate.contains("0:00") {
                    time_remaining = Some(candidate.to_string());
                }
            }
        }
        break;
    }
    BatteryStatus { percent, charging, time_remaining }
}

/// Single round-trip the renderer uses on boot — home dir + persisted state
/// + zoxide recents in one IPC instead of three. Resolves the state path
/// through `state::state_path()` so dev and release builds stay separated.
#[tauri::command]
pub fn boot_init() -> BootInfo {
    let home = home_dir();
    let state = state_path()
        .and_then(|p| fs::read_to_string(p).ok())
        .unwrap_or_default();
    BootInfo {
        home,
        state,
        recent: zoxide_dirs(),
    }
}

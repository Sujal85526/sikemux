use std::process::Command;

#[tauri::command]
pub fn home_dir() -> String {
    std::env::var("HOME").unwrap_or_default()
}

// Frecency-ranked directories from zoxide, for the sesh picker. Returns an
// empty list if zoxide isn't installed. Tries PATH first, then the common
// Homebrew locations a GUI-launched app might miss.
#[tauri::command]
pub fn recent_dirs() -> Vec<String> {
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

use std::fs;
use std::process::Command;

use serde::Serialize;

use crate::state::state_path;

/// macOS GUI apps launched from Finder/Dock inherit launchd's minimal PATH
/// (`/usr/bin:/bin:/usr/sbin:/sbin`), missing `~/.local/bin`,
/// `/opt/homebrew/bin`, `~/.cargo/bin`, `~/.opencode/bin`, etc. that the
/// user actually has tools in. `make dev` works because the dev binary is
/// launched from a terminal that already has the right PATH.
///
/// Fix: at startup, exec the user's login shell with `-l -c 'printf %s
/// "$PATH"'` to extract the real PATH, then set it on our own process so
/// every `Command::new(...)` (hermes, rnd, aws, claude, …) inherits it.
/// Standard "fix-path" pattern Electron + Tauri apps have used for years.
pub fn fix_path_from_login_shell() {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());

    // Login shell only (`-l`): sources .zprofile / .bash_profile, captures
    // the user's exported PATH without zsh interactive's terminal-CWD OSC
    // escapes (which would contaminate the first PATH entry).
    let mut shell_path = String::new();
    if let Ok(o) = Command::new(&shell)
        .args(["-l", "-c", "printf %s \"$PATH\""])
        .output()
    {
        if o.status.success() {
            shell_path = String::from_utf8_lossy(&o.stdout).trim().to_string();
        }
    }

    // Always-union: even if the shell extraction succeeded, append the
    // common user-local bin dirs in case they live in ~/.zshrc (which
    // login shells don't source) or in non-zsh setups. Idempotent —
    // duplicates are harmless to PATH lookup.
    let home = std::env::var("HOME").unwrap_or_default();
    let extra = [
        format!("{home}/.local/bin"),
        format!("{home}/.cargo/bin"),
        format!("{home}/.opencode/bin"),
        format!("{home}/.config/shell/bin"),
        format!("{home}/go/bin"),
        // Node tooling: typescript-language-server, pyright, vue-lsp, etc.
        // installed via `pnpm add -g` land here on macOS.
        format!("{home}/Library/pnpm"),
        format!("{home}/.npm/bin"),
        format!("{home}/.bun/bin"),
        // Python virtualenv tooling (pipx, pyenv shims).
        format!("{home}/.pyenv/shims"),
        "/opt/homebrew/bin".to_string(),
        "/opt/homebrew/sbin".to_string(),
        "/usr/local/bin".to_string(),
    ];
    let mut parts: Vec<&str> = shell_path.split(':').filter(|s| !s.is_empty()).collect();
    for d in &extra {
        if !parts.iter().any(|p| *p == d.as_str()) {
            parts.push(d.as_str());
        }
    }
    // Fall back to the launchd minimal set if shell extraction failed AND
    // none of the extras hit — guarantees `/usr/bin` etc. stay reachable.
    if parts.is_empty() {
        parts = vec!["/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
    }
    let new_path = parts.join(":");
    // SAFETY: called once at startup before any threads spawn — env::set_var
    // is unsound under multi-threaded mutation but we're single-threaded.
    unsafe { std::env::set_var("PATH", new_path) };
}

/// Raise this process's open-file-descriptor soft limit toward its hard
/// limit. See the call site in `lib.rs` for the why: macOS `launchd` hands
/// GUI-launched apps a soft `RLIMIT_NOFILE` of 256, but sikemux holds one
/// fd per live PTY plus the webview, language servers, fs watchers, and
/// sockets — a heavy multi-terminal/agent/project session blows past 256
/// and every fd-hungry op (git, spawning a process, opening a file) then
/// fails with EMFILE ("Too many open files"). A higher limit costs no
/// memory — it's a ceiling, not an allocation — so this is safe on low-end
/// devices too.
#[cfg(unix)]
pub fn raise_fd_limit() {
    unsafe {
        let mut lim = std::mem::zeroed::<libc::rlimit>();
        if libc::getrlimit(libc::RLIMIT_NOFILE, &mut lim) != 0 {
            return;
        }
        // Dev builds inherit the launching terminal's already-high ulimit;
        // nothing to do there.
        if lim.rlim_cur >= 65_536 {
            return;
        }
        // Try progressively smaller soft limits until one sticks. macOS
        // rejects a soft limit above `kern.maxfilesperproc` with EINVAL, so
        // we descend; even the smallest rung (10_240) dwarfs launchd's 256
        // and covers thousands of PTYs/sockets.
        for &cand in &[131_072u64, 65_536, 16_384, 10_240] {
            let cand = cand as libc::rlim_t;
            let hard = lim.rlim_max;
            let target = if hard == libc::RLIM_INFINITY {
                cand
            } else if cand <= hard {
                cand
            } else {
                hard
            };
            if target <= lim.rlim_cur {
                continue;
            }
            let next = libc::rlimit {
                rlim_cur: target,
                rlim_max: lim.rlim_max,
            };
            if libc::setrlimit(libc::RLIMIT_NOFILE, &next) == 0 {
                return;
            }
        }
    }
}

#[cfg(not(unix))]
pub fn raise_fd_limit() {}

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
    for bin in [
        "zoxide",
        "/opt/homebrew/bin/zoxide",
        "/usr/local/bin/zoxide",
    ] {
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
        return BatteryStatus {
            percent: None,
            charging: false,
            time_remaining: None,
        };
    }
    #[cfg(target_os = "macos")]
    {
        let out = match Command::new("pmset").args(["-g", "batt"]).output() {
            Ok(o) if o.status.success() => o,
            _ => {
                return BatteryStatus {
                    percent: None,
                    charging: false,
                    time_remaining: None,
                }
            }
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
    BatteryStatus {
        percent,
        charging,
        time_remaining,
    }
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

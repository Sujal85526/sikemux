// Parses ~/.ssh/config and returns the user's host aliases.
//
// SSH config is simple line-oriented: `Host alias [alias…]` opens a block,
// and key/value lines apply to whatever block is currently open. We collect
// HostName, User, Port — enough to render a useful subtitle in the picker.
// Wildcard aliases (containing `*` or `?`) are skipped because they're
// config templates, not connectable hosts.
//
// `Include` directives are not followed for v1 — almost every dev keeps
// their hosts in the main config; revisit when someone actually needs it.

use std::fs;
use std::path::PathBuf;

use serde::Serialize;

use crate::error::{AppError, AppResult};
#[derive(Serialize)]
pub struct SshHost {
    alias: String,
    hostname: Option<String>,
    user: Option<String>,
    port: Option<u16>,
}

fn flush(
    out: &mut Vec<SshHost>,
    aliases: &[String],
    hn: &Option<String>,
    user: &Option<String>,
    port: Option<u16>,
) {
    for alias in aliases {
        if alias.contains('*') || alias.contains('?') {
            continue;
        }
        out.push(SshHost {
            alias: alias.clone(),
            hostname: hn.clone(),
            user: user.clone(),
            port,
        });
    }
}

fn config_path() -> AppResult<PathBuf> {
    let home = std::env::var("HOME").map_err(|_| AppError::Fs("HOME is not set".into()))?;
    Ok(PathBuf::from(home).join(".ssh/config"))
}

#[tauri::command]
pub fn ssh_hosts() -> Vec<SshHost> {
    let Ok(path) = config_path() else {
        return Vec::new();
    };
    let Ok(content) = fs::read_to_string(&path) else {
        return Vec::new();
    };

    let mut out: Vec<SshHost> = Vec::new();
    let mut aliases: Vec<String> = Vec::new();
    let mut hn: Option<String> = None;
    let mut user: Option<String> = None;
    let mut port: Option<u16> = None;

    for raw in content.lines() {
        // Strip inline comments and surrounding whitespace.
        let line = raw.split('#').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }

        // SSH config keys are separated from values by whitespace or `=`.
        let mut split = line.splitn(2, |c: char| c.is_whitespace() || c == '=');
        let key = split.next().unwrap_or("");
        let value = split
            .next()
            .unwrap_or("")
            .trim_start_matches(|c: char| c.is_whitespace() || c == '=')
            .trim();
        if value.is_empty() {
            continue;
        }
        let key_lc = key.to_ascii_lowercase();

        if key_lc == "host" {
            flush(&mut out, &aliases, &hn, &user, port);
            aliases = value.split_whitespace().map(String::from).collect();
            hn = None;
            user = None;
            port = None;
            continue;
        }

        match key_lc.as_str() {
            "hostname" => hn = Some(value.to_string()),
            "user" => user = Some(value.to_string()),
            "port" => port = value.parse().ok(),
            _ => {}
        }
    }
    flush(&mut out, &aliases, &hn, &user, port);
    out
}

/// Ensure the SSH editor has a real file to open, without ever modifying an
/// existing config. Returning the canonical app path keeps the frontend's
/// regular file editor independent of platform-specific home discovery.
#[tauri::command]
pub fn ssh_config_ensure() -> AppResult<String> {
    let path = config_path()?;
    let ssh_dir = path
        .parent()
        .ok_or_else(|| AppError::Fs("invalid SSH config path".into()))?;
    if !ssh_dir.exists() {
        fs::create_dir_all(ssh_dir)?;
        #[cfg(unix)]
        fs::set_permissions(ssh_dir, std::os::unix::fs::PermissionsExt::from_mode(0o700))?;
    }
    if !path.exists() {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options.open(&path)?;
    }
    Ok(path.to_string_lossy().into_owned())
}

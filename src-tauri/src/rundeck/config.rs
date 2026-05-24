// ~/.rd-config — byte-compatible with the bash `rnd` CLI so terminal and
// in-app workflows share one credential store. The CLI writes lines like
// `RD_URL=%q`-formatted (POSIX-quoted); we accept that form on read but
// always write plain-quoted strings on save. Either form re-parses cleanly.
//
// One global RwLock<RundeckConfig> holds the in-process cache. The HTTP
// client refreshes from disk before every request so a `rnd login` in a
// terminal is picked up without restarting the app.

use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RundeckConfig {
    pub url: String,
    pub user: String,
    /// Cleartext password — same as the bash CLI does. Used only to silently
    /// re-auth when a token is rejected. Lives in a chmod-600 file.
    pub password: String,
    pub token: String,
}

impl RundeckConfig {
    pub fn is_configured(&self) -> bool {
        !self.url.is_empty() && !self.token.is_empty()
    }
}

pub fn config_path() -> Option<PathBuf> {
    std::env::var("HOME").ok().map(|h| PathBuf::from(h).join(".rd-config"))
}

/// Strip POSIX-style %q quoting that bash's `printf '%q'` produces. Handles
/// the common subset we actually emit / receive: single-quoted strings,
/// dollar-quoted ($'...'), and plain bare words.
fn unquote(raw: &str) -> String {
    let s = raw.trim();
    if s.len() >= 2 && s.starts_with('\'') && s.ends_with('\'') {
        return s[1..s.len() - 1].replace("'\\''", "'");
    }
    if s.len() >= 3 && s.starts_with("$'") && s.ends_with('\'') {
        // $'...': interpret \n, \t, \', \\
        let inner = &s[2..s.len() - 1];
        let mut out = String::with_capacity(inner.len());
        let mut chars = inner.chars().peekable();
        while let Some(c) = chars.next() {
            if c != '\\' {
                out.push(c);
                continue;
            }
            match chars.next() {
                Some('n') => out.push('\n'),
                Some('t') => out.push('\t'),
                Some('r') => out.push('\r'),
                Some('\\') => out.push('\\'),
                Some('\'') => out.push('\''),
                Some(other) => {
                    out.push('\\');
                    out.push(other);
                }
                None => out.push('\\'),
            }
        }
        return out;
    }
    if s.len() >= 2 && s.starts_with('"') && s.ends_with('"') {
        return s[1..s.len() - 1].to_string();
    }
    s.to_string()
}

/// Quote a value for write — single-quoted, escaping embedded single quotes
/// using the bash idiom `'\''`. Round-trips through `unquote`.
fn quote(s: &str) -> String {
    let escaped = s.replace('\'', "'\\''");
    format!("'{escaped}'")
}

fn read_file() -> AppResult<RundeckConfig> {
    let Some(path) = config_path() else {
        return Ok(RundeckConfig::default());
    };
    if !path.exists() {
        return Ok(RundeckConfig::default());
    }
    let content = fs::read_to_string(&path)?;
    let mut cfg = RundeckConfig::default();
    for raw in content.lines() {
        let line = raw.split('#').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        let Some((k, v)) = line.split_once('=') else { continue };
        let val = unquote(v);
        match k.trim() {
            "RD_URL" => cfg.url = val.trim_end_matches('/').to_string(),
            "RD_USER" => cfg.user = val,
            "RD_PASSWORD" => cfg.password = val,
            "RD_TOKEN" => cfg.token = val,
            _ => {}
        }
    }
    Ok(cfg)
}

fn write_file(cfg: &RundeckConfig) -> AppResult<()> {
    let Some(path) = config_path() else {
        return Err(AppError::Rundeck("no HOME directory".into()));
    };
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&path)?;
    writeln!(file, "RD_URL={}", quote(&cfg.url))?;
    writeln!(file, "RD_USER={}", quote(&cfg.user))?;
    writeln!(file, "RD_PASSWORD={}", quote(&cfg.password))?;
    writeln!(file, "RD_TOKEN={}", quote(&cfg.token))?;
    // chmod 600 — matches the CLI; reqwest doesn't care but the user's other
    // tools (the bash CLI) refuse to source a world-readable secrets file.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perm = fs::metadata(&path)?.permissions();
        perm.set_mode(0o600);
        fs::set_permissions(&path, perm)?;
    }
    Ok(())
}

fn cache() -> &'static RwLock<RundeckConfig> {
    static C: OnceLock<RwLock<RundeckConfig>> = OnceLock::new();
    C.get_or_init(|| RwLock::new(RundeckConfig::default()))
}

/// Reload the in-process cache from disk. Called before each request — cheap
/// (small file, OS cache) and ensures a `rnd login` from a terminal is
/// picked up live.
pub async fn refresh_from_disk() -> AppResult<RundeckConfig> {
    let fresh = read_file()?;
    let mut w = cache().write().await;
    *w = fresh.clone();
    Ok(fresh)
}

pub async fn get() -> RundeckConfig {
    cache().read().await.clone()
}

pub async fn save(cfg: RundeckConfig) -> AppResult<()> {
    write_file(&cfg)?;
    let mut w = cache().write().await;
    *w = cfg;
    Ok(())
}

/// Update only the token (used after auto-refresh). Keeps url/user/password
/// untouched so we don't race with a concurrent `save` carrying new creds.
pub async fn update_token(token: String) -> AppResult<()> {
    let mut w = cache().write().await;
    w.token = token;
    write_file(&w)?;
    Ok(())
}

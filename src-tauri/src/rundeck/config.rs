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
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::SystemTime;

use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RundeckConfig {
    pub url: String,
    pub user: String,
    /// Ephemeral login password received from the UI. It is never written to
    /// disk and is cleared from the returned/saved configuration.
    pub password: String,
    pub token: String,
}

impl RundeckConfig {
    pub fn is_configured(&self) -> bool {
        !self.url.is_empty() && !self.token.is_empty()
    }
}

pub fn config_path() -> Option<PathBuf> {
    std::env::var("HOME")
        .ok()
        .map(|h| PathBuf::from(h).join(".rd-config"))
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
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        if line.starts_with('#') {
            continue;
        }
        let Some((k, v)) = line.split_once('=') else {
            continue;
        };
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
    write_file_at(&path, cfg)
}

fn write_file_at(path: &Path, cfg: &RundeckConfig) -> AppResult<()> {
    validate_base_url(&cfg.url)?;
    let parent = path
        .parent()
        .ok_or_else(|| AppError::Rundeck("invalid config path".into()))?;
    fs::create_dir_all(parent)?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        temp.as_file()
            .set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    writeln!(temp, "RD_URL={}", quote(&cfg.url))?;
    writeln!(temp, "RD_USER={}", quote(&cfg.user))?;
    // Passwords are intentionally never persisted. A rejected token now asks
    // the user to log in again rather than retaining a reusable password.
    writeln!(temp, "RD_PASSWORD={}", quote(""))?;
    writeln!(temp, "RD_TOKEN={}", quote(&cfg.token))?;
    temp.as_file_mut().sync_all()?;
    temp.persist(path).map_err(|e| AppError::Io(e.error))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

pub fn validate_base_url(raw: &str) -> AppResult<()> {
    let url = url::Url::parse(raw).map_err(|_| AppError::BadArg("invalid Rundeck URL"))?;
    if url.username() != "" || url.password().is_some() {
        return Err(AppError::BadArg(
            "credentials in the Rundeck URL are not allowed",
        ));
    }
    if !matches!(url.scheme(), "http" | "https") {
        return Err(AppError::BadArg("Rundeck URL must use HTTP or HTTPS"));
    }
    Ok(())
}

struct CacheEntry {
    cfg: RundeckConfig,
    /// mtime of `~/.rd-config` at the last successful read. `None` means
    /// the cache is empty / the file didn't exist.
    seen_mtime: Option<SystemTime>,
}

fn cache() -> &'static RwLock<CacheEntry> {
    static C: OnceLock<RwLock<CacheEntry>> = OnceLock::new();
    C.get_or_init(|| {
        RwLock::new(CacheEntry {
            cfg: RundeckConfig::default(),
            seen_mtime: None,
        })
    })
}

fn mtime_of(path: &PathBuf) -> Option<SystemTime> {
    fs::metadata(path).ok().and_then(|m| m.modified().ok())
}

/// Reload the in-process cache from disk when `~/.rd-config` has changed.
/// Called before every Rundeck API request — used to re-read the file
/// each time (~600 B), which was visible during heavy log-tail polling
/// (2 pollers × every 1.5s × multiple disk reads each). Now we stat the
/// file (one syscall) and only re-read on an mtime change, so a long
/// session with no `rnd login` does effectively zero disk work.
pub async fn refresh_from_disk() -> AppResult<RundeckConfig> {
    let path = match config_path() {
        Some(p) => p,
        None => return Ok(RundeckConfig::default()),
    };
    let cur_mtime = mtime_of(&path);
    {
        let r = cache().read().await;
        if r.seen_mtime == cur_mtime && cur_mtime.is_some() {
            return Ok(r.cfg.clone());
        }
    }
    let fresh = read_file()?;
    let mut w = cache().write().await;
    w.cfg = fresh.clone();
    w.seen_mtime = cur_mtime;
    Ok(fresh)
}

pub async fn get() -> RundeckConfig {
    cache().read().await.cfg.clone()
}

pub async fn save(cfg: RundeckConfig) -> AppResult<()> {
    write_file(&cfg)?;
    let path = config_path();
    let mut w = cache().write().await;
    w.cfg = cfg;
    w.seen_mtime = path.as_ref().and_then(mtime_of);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_configured_http_and_https_servers() {
        assert!(validate_base_url("https://rundeck.example.com").is_ok());
        assert!(validate_base_url("http://localhost:4440").is_ok());
        assert!(validate_base_url("http://rundeck.example.com").is_ok());
        assert!(validate_base_url("ftp://rundeck.example.com").is_err());
        assert!(validate_base_url("https://user:pass@rundeck.example.com").is_err());
    }

    #[test]
    fn writes_atomically_without_persisting_password() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rd-config");
        let cfg = RundeckConfig {
            url: "https://rundeck.example.com".into(),
            user: "alice".into(),
            password: "never-store-me".into(),
            token: "token".into(),
        };
        write_file_at(&path, &cfg).unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert!(!text.contains("never-store-me"));
        assert!(text.contains("RD_PASSWORD=''"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }
}

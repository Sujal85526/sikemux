// Where SigNoz lives and where its key is kept. The key sits in the macOS
// Keychain under the same service the `signoz` shell CLI reads, and the same
// SIGNOZ_URL / SIGNOZ_API_KEY variables win over it, so signing in from
// either place signs in both.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::error::{SignozError, SignozResult};

const KEYCHAIN_SERVICE: &str = "signoz-api";
const KEYCHAIN_TIMEOUT: Duration = Duration::from_secs(10);
const KEYCHAIN_OUTPUT_LIMIT: usize = 64 * 1024;

#[derive(Serialize, Deserialize, Clone, Default, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SignozConfig {
    pub url: String,
    pub account: String,
}

#[derive(Clone)]
pub struct Credentials {
    pub url: String,
    pub api_key: String,
}

static CACHED_KEY: Mutex<Option<(String, String)>> = Mutex::new(None);

fn config_path(data_dir: &Path) -> PathBuf {
    data_dir.join("config.json")
}

pub fn load(data_dir: &Path) -> SignozConfig {
    let mut config: SignozConfig = std::fs::read(config_path(data_dir))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    if let Ok(url) = std::env::var("SIGNOZ_URL") {
        if !url.trim().is_empty() {
            config.url = url.trim().trim_end_matches('/').to_string();
        }
    }
    config
}

pub fn save(data_dir: &Path, config: &SignozConfig) -> SignozResult<()> {
    let transport =
        |error: std::io::Error| SignozError::Transport(format!("saving settings: {error}"));
    std::fs::create_dir_all(data_dir).map_err(transport)?;
    let path = config_path(data_dir);
    let staged = path.with_extension("json.tmp");
    std::fs::write(&staged, serde_json::to_vec_pretty(config)?).map_err(transport)?;
    std::fs::rename(&staged, &path).map_err(transport)
}

pub fn validate_url(raw: &str) -> SignozResult<String> {
    let trimmed = raw.trim().trim_end_matches('/');
    let url = url::Url::parse(trimmed)
        .map_err(|_| SignozError::BadArg("the SigNoz URL is not a URL".into()))?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err(SignozError::BadArg(
            "put the API key in the key field, not the URL".into(),
        ));
    }
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    match url.scheme() {
        "https" => {}
        "http" if local => {}
        _ => {
            return Err(SignozError::BadArg(
                "SigNoz must be reached over HTTPS, or HTTP on this machine".into(),
            ))
        }
    }
    Ok(trimmed.to_string())
}

pub fn validate_account(raw: &str) -> SignozResult<String> {
    let account = raw.trim();
    let allowed = |c: char| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-');
    if account.is_empty() || account.len() > 64 || !account.chars().all(allowed) {
        return Err(SignozError::BadArg(
            "the Keychain account is letters, digits, dots, dashes and underscores".into(),
        ));
    }
    Ok(account.to_string())
}

fn validate_key(raw: &str) -> SignozResult<String> {
    let key = raw.trim();
    let allowed =
        |c: char| c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '=' | '_' | '-' | '.');
    if key.is_empty() || key.len() > 256 || !key.chars().all(allowed) {
        return Err(SignozError::BadArg(
            "that does not look like a SigNoz API key".into(),
        ));
    }
    Ok(key.to_string())
}

fn run_security(args: &[&str], input: Option<&[u8]>) -> SignozResult<std::process::Output> {
    let mut command = Command::new("security");
    command.args(args);
    sikemux_process::run(
        &mut command,
        input,
        KEYCHAIN_TIMEOUT,
        KEYCHAIN_OUTPUT_LIMIT,
        None,
    )
    .map_err(|error| SignozError::Keychain(error.to_string()))
}

fn keychain_read(account: &str) -> SignozResult<Option<String>> {
    let output = run_security(
        &[
            "find-generic-password",
            "-s",
            KEYCHAIN_SERVICE,
            "-a",
            account,
            "-w",
        ],
        None,
    )?;
    if !output.status.success() {
        return Ok(None);
    }
    let key = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok((!key.is_empty()).then_some(key))
}

/// `security -i` reads the command from stdin, so the key never shows up in
/// the process list the way an argument would.
pub fn keychain_write(account: &str, key: &str) -> SignozResult<()> {
    let key = validate_key(key)?;
    let line = format!("add-generic-password -U -s {KEYCHAIN_SERVICE} -a {account} -w {key}\n");
    let output = run_security(&["-i"], Some(line.as_bytes()))?;
    if !output.status.success() {
        return Err(SignozError::Keychain("the Keychain refused the key".into()));
    }
    forget_cached_key();
    Ok(())
}

pub fn has_env_key() -> bool {
    std::env::var("SIGNOZ_API_KEY").is_ok_and(|key| !key.trim().is_empty())
}

/// Reading the Keychain starts a process, so the key is kept after the first
/// read and dropped when SigNoz turns it down.
pub fn credentials(data_dir: &Path) -> SignozResult<Credentials> {
    let config = load(data_dir);
    if config.url.is_empty() {
        return Err(SignozError::Unconfigured);
    }
    if let Ok(key) = std::env::var("SIGNOZ_API_KEY") {
        if !key.trim().is_empty() {
            return Ok(Credentials {
                url: config.url,
                api_key: key.trim().to_string(),
            });
        }
    }
    if config.account.is_empty() {
        return Err(SignozError::Unconfigured);
    }
    let mut cached = CACHED_KEY
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some((account, key)) = cached.as_ref() {
        if account == &config.account {
            return Ok(Credentials {
                url: config.url,
                api_key: key.clone(),
            });
        }
    }
    let key = keychain_read(&config.account)?.ok_or(SignozError::Unconfigured)?;
    *cached = Some((config.account.clone(), key.clone()));
    Ok(Credentials {
        url: config.url,
        api_key: key,
    })
}

pub fn forget_cached_key() {
    *CACHED_KEY
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_https_and_local_http_only() {
        assert_eq!(
            validate_url("https://logs.example.com/").unwrap(),
            "https://logs.example.com"
        );
        assert!(validate_url("http://localhost:8080").is_ok());
        assert!(validate_url("http://logs.example.com").is_err());
        assert!(validate_url("https://user:key@logs.example.com").is_err());
        assert!(validate_url("logs.example.com").is_err());
    }

    #[test]
    fn keeps_keychain_arguments_to_safe_characters() {
        assert!(validate_account("work").is_ok());
        assert!(validate_account("a b").is_err());
        assert!(validate_key("abc+/=_-.").is_ok());
        assert!(validate_key("abc def").is_err());
        assert!(validate_key("abc\n-a other").is_err());
    }

    #[test]
    fn round_trips_the_config_file() {
        let dir = std::env::temp_dir().join(format!("sikemux-signoz-{}", std::process::id()));
        let config = SignozConfig {
            url: "https://logs.example.com".into(),
            account: "work".into(),
        };
        save(&dir, &config).unwrap();
        assert_eq!(load(&dir).url, config.url);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

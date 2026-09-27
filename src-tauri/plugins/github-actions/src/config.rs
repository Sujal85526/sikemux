// Which GitHub this talks to and the token it carries. A token Sikemux saved
// lives in the Keychain; one already in the environment, or one the `gh` CLI
// is holding, is used as it is and never copied anywhere.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::error::{ActionsError, ActionsResult};

pub const TOKEN_SERVICE: &str = "sikemux-github-token";
pub const DEFAULT_HOST: &str = "github.com";
const KEYCHAIN_TIMEOUT: Duration = Duration::from_secs(10);
const GH_TIMEOUT: Duration = Duration::from_secs(10);
const OUTPUT_LIMIT: usize = 64 * 1024;

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum TokenSource {
    Keychain,
    Environment,
    GhCli,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ActionsConfig {
    pub host: String,
    #[serde(default)]
    pub login: String,
    /// Whether Sikemux saved the Keychain token, and so may delete it on sign-out.
    #[serde(default)]
    pub owns_token: bool,
}

impl Default for ActionsConfig {
    fn default() -> Self {
        Self {
            host: DEFAULT_HOST.to_string(),
            login: String::new(),
            owns_token: false,
        }
    }
}

fn config_path(data_dir: &Path) -> PathBuf {
    data_dir.join("config.json")
}

pub fn load(data_dir: &Path) -> ActionsConfig {
    let mut config: ActionsConfig = std::fs::read(config_path(data_dir))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    if let Ok(host) = std::env::var("GH_HOST") {
        if let Ok(host) = validate_host(&host) {
            config.host = host;
        }
    }
    if config.host.is_empty() {
        config.host = DEFAULT_HOST.to_string();
    }
    config
}

fn io_error(error: std::io::Error) -> ActionsError {
    ActionsError::Transport(format!("saving settings: {error}"))
}

pub fn save(data_dir: &Path, config: &ActionsConfig) -> ActionsResult<()> {
    std::fs::create_dir_all(data_dir).map_err(io_error)?;
    let path = config_path(data_dir);
    let staged = path.with_extension("json.tmp");
    std::fs::write(&staged, serde_json::to_vec_pretty(config)?).map_err(io_error)?;
    std::fs::rename(&staged, &path).map_err(io_error)
}

pub fn forget(data_dir: &Path) -> ActionsResult<()> {
    match std::fs::remove_file(config_path(data_dir)) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(io_error(error)),
        _ => Ok(()),
    }
}

fn valid_label(label: &str) -> bool {
    !label.is_empty()
        && label.len() <= 63
        && !label.starts_with('-')
        && !label.ends_with('-')
        && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// A bare hostname, with a port only when one was given. People paste whole
/// URLs, so a scheme, a user and a path are trimmed off rather than refused.
pub fn validate_host(raw: &str) -> ActionsResult<String> {
    let bad = || ActionsError::BadArg("that is not a GitHub hostname".into());
    let trimmed = raw.trim();
    let after_scheme = trimmed.split_once("://").map_or(trimmed, |(_, rest)| rest);
    let authority = after_scheme.split('/').next().unwrap_or(after_scheme);
    let authority = authority.split('@').next_back().unwrap_or(authority);
    let (host, port) = match authority.rsplit_once(':') {
        Some((host, port)) => (host, Some(port)),
        None => (authority, None),
    };
    if let Some(port) = port {
        let numeric =
            !port.is_empty() && port.len() <= 5 && port.chars().all(|c| c.is_ascii_digit());
        if !numeric {
            return Err(bad());
        }
    }
    if host.is_empty() || host.len() > 253 || !host.split('.').all(valid_label) {
        return Err(bad());
    }
    Ok(authority.to_ascii_lowercase())
}

/// github.com serves its API from a host of its own; every other GitHub serves
/// it from `/api/v3` on the host itself.
pub fn api_base(host: &str) -> String {
    if host == DEFAULT_HOST {
        "https://api.github.com".to_string()
    } else {
        format!("https://{host}/api/v3")
    }
}

fn validate_account(raw: &str) -> ActionsResult<String> {
    let account = raw.trim();
    let allowed = |c: char| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ':');
    if account.is_empty() || account.len() > 128 || !account.chars().all(allowed) {
        return Err(ActionsError::BadArg(
            "the Keychain account is letters, digits, dots, dashes and underscores".into(),
        ));
    }
    Ok(account.to_string())
}

/// Secrets reach `security -i` on a command line it splits on spaces, so
/// anything that could end the value early is refused rather than escaped.
fn validate_secret(raw: &str) -> ActionsResult<String> {
    let secret = raw.trim();
    let allowed = |c: char| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '~');
    if secret.is_empty() || secret.len() > 1024 || !secret.chars().all(allowed) {
        return Err(ActionsError::BadArg(
            "that does not look like a GitHub token".into(),
        ));
    }
    Ok(secret.to_string())
}

fn run(
    command: &mut Command,
    input: Option<&[u8]>,
    timeout: Duration,
) -> ActionsResult<std::process::Output> {
    sikemux_process::run(command, input, timeout, OUTPUT_LIMIT, None)
        .map_err(|error| ActionsError::Keychain(error.to_string()))
}

pub fn keychain_read(account: &str) -> ActionsResult<Option<String>> {
    let output = run(
        Command::new("security").args([
            "find-generic-password",
            "-s",
            TOKEN_SERVICE,
            "-a",
            account,
            "-w",
        ]),
        None,
        KEYCHAIN_TIMEOUT,
    )?;
    if !output.status.success() {
        return Ok(None);
    }
    let secret = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok((!secret.is_empty()).then_some(secret))
}

/// `security -i` reads the command from stdin, so the token never shows up in
/// the process list the way an argument would.
pub fn keychain_write(account: &str, secret: &str) -> ActionsResult<()> {
    let account = validate_account(account)?;
    let secret = validate_secret(secret)?;
    let line = format!("add-generic-password -U -s {TOKEN_SERVICE} -a {account} -w {secret}\n");
    let output = run(
        Command::new("security").arg("-i"),
        Some(line.as_bytes()),
        KEYCHAIN_TIMEOUT,
    )?;
    if !output.status.success() {
        return Err(ActionsError::Keychain(
            "the Keychain refused to save it".into(),
        ));
    }
    Ok(())
}

pub fn keychain_delete(account: &str) -> ActionsResult<()> {
    run(
        Command::new("security").args([
            "delete-generic-password",
            "-s",
            TOKEN_SERVICE,
            "-a",
            account,
        ]),
        None,
        KEYCHAIN_TIMEOUT,
    )?;
    Ok(())
}

pub fn env_token() -> Option<String> {
    ["GH_TOKEN", "GITHUB_TOKEN"]
        .into_iter()
        .filter_map(|name| std::env::var(name).ok())
        .map(|token| token.trim().to_string())
        .find(|token| !token.is_empty())
}

/// The token the `gh` CLI is already signed in with, so somebody who has run
/// `gh auth login` never types one here.
pub fn gh_cli_token(host: &str) -> Option<String> {
    let output = run(
        Command::new("gh").args(["auth", "token", "--hostname", host]),
        None,
        GH_TIMEOUT,
    )
    .ok()?;
    if !output.status.success() {
        return None;
    }
    let token = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!token.is_empty()).then_some(token)
}

/// The token to use, and where it came from. A token Sikemux saved wins, so
/// signing in here overrides whatever the shell happens to export.
pub fn resolve_token(config: &ActionsConfig) -> Option<(String, TokenSource)> {
    if let Ok(Some(token)) = keychain_read(&config.host) {
        return Some((token, TokenSource::Keychain));
    }
    if let Some(token) = env_token() {
        return Some((token, TokenSource::Environment));
    }
    gh_cli_token(&config.host).map(|token| (token, TokenSource::GhCli))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_hostname_out_of_whatever_was_pasted() -> ActionsResult<()> {
        for raw in [
            "github.com",
            "https://github.com",
            "https://github.com/",
            "https://github.com/nodelike",
            "  GitHub.com  ",
            "git@github.com",
        ] {
            assert_eq!(validate_host(raw)?, "github.com", "{raw}");
        }
        assert_eq!(
            validate_host("git.example.com:8443")?,
            "git.example.com:8443"
        );
        Ok(())
    }

    #[test]
    fn turns_down_things_that_are_not_hostnames() {
        for raw in [
            "",
            "   ",
            "git hub.com",
            "https://",
            "/",
            "github.com:",
            "github.com:notaport",
            "-github.com",
            "git_hub.com",
        ] {
            assert!(validate_host(raw).is_err(), "{raw}");
        }
    }

    #[test]
    fn github_dot_com_has_its_own_api_host() {
        assert_eq!(api_base("github.com"), "https://api.github.com");
        assert_eq!(
            api_base("git.example.com"),
            "https://git.example.com/api/v3"
        );
    }

    #[test]
    fn keeps_keychain_arguments_to_safe_characters() {
        assert!(validate_account("github.com").is_ok());
        assert!(validate_account("a b").is_err());
        assert!(validate_secret("github_pat_11ABC-def.xyz~").is_ok());
        assert!(validate_secret("ghp_abc def").is_err());
        assert!(validate_secret("ghp_abc\n-a other").is_err());
        assert!(validate_secret("").is_err());
    }

    #[test]
    fn round_trips_the_config_file() -> ActionsResult<()> {
        let dir = std::env::temp_dir().join(format!("sikemux-gha-{}", std::process::id()));
        let config = ActionsConfig {
            host: "git.example.com".into(),
            login: "octocat".into(),
            owns_token: true,
        };
        save(&dir, &config)?;
        assert_eq!(load(&dir).login, "octocat");
        forget(&dir)?;
        assert_eq!(load(&dir).host, DEFAULT_HOST);
        std::fs::remove_dir_all(&dir).ok();
        Ok(())
    }

    #[test]
    fn forgetting_a_config_that_was_never_saved_is_fine() {
        let dir = std::env::temp_dir().join(format!("sikemux-gha-none-{}", std::process::id()));
        assert!(forget(&dir).is_ok());
    }
}

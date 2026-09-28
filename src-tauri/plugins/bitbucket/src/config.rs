// How this is signed in to Bitbucket. The secret itself, an OAuth refresh
// token or an API token, lives in the Keychain; the file beside it only says
// which of the two it is and who it belongs to.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::error::{BitbucketError, BitbucketResult};

#[cfg(not(test))]
const TOKEN_SERVICE: &str = "sikemux-bitbucket-token";
/// Tests keep to an entry of their own, so they never replace or delete a real token.
#[cfg(test)]
const TOKEN_SERVICE: &str = "sikemux-bitbucket-token-test";
const KEYCHAIN_TIMEOUT: Duration = Duration::from_secs(10);
const OUTPUT_LIMIT: usize = 64 * 1024;
/// What `security` exits with when there is simply no such entry.
const KEYCHAIN_NOT_FOUND: i32 = 44;

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum Method {
    /// Signed in through the browser; the Keychain holds a refresh token.
    Oauth,
    /// A pasted API token or access token; the Keychain holds the token.
    Token,
}

impl Method {
    fn account(self) -> &'static str {
        match self {
            Self::Oauth => "oauth",
            Self::Token => "token",
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Default, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BitbucketConfig {
    #[serde(default)]
    pub method: Option<Method>,
    #[serde(default)]
    pub login: String,
    /// An Atlassian API token is sent with the account's email; an access
    /// token made for a repository or workspace is sent on its own.
    #[serde(default)]
    pub email: Option<String>,
}

fn config_path(data_dir: &Path) -> PathBuf {
    data_dir.join("config.json")
}

pub fn load(data_dir: &Path) -> BitbucketConfig {
    std::fs::read(config_path(data_dir))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn io_error(error: std::io::Error) -> BitbucketError {
    BitbucketError::Transport(format!("saving settings: {error}"))
}

pub fn save(data_dir: &Path, config: &BitbucketConfig) -> BitbucketResult<()> {
    std::fs::create_dir_all(data_dir).map_err(io_error)?;
    let path = config_path(data_dir);
    let staged = path.with_extension("json.tmp");
    std::fs::write(&staged, serde_json::to_vec_pretty(config)?).map_err(io_error)?;
    std::fs::rename(&staged, &path).map_err(io_error)
}

/// Secrets reach `security -i` on a command line it splits on spaces, so
/// anything that could end the value early is refused rather than escaped.
fn validate_secret(raw: &str) -> BitbucketResult<String> {
    let secret = raw.trim();
    let allowed =
        |c: char| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '~' | '=' | '+' | '/');
    if secret.is_empty() || secret.len() > 4096 || !secret.chars().all(allowed) {
        return Err(BitbucketError::BadArg(
            "that does not look like a Bitbucket token".into(),
        ));
    }
    Ok(secret.to_string())
}

fn run(
    command: &mut Command,
    input: Option<&[u8]>,
    timeout: Duration,
) -> BitbucketResult<std::process::Output> {
    sikemux_process::run(command, input, timeout, OUTPUT_LIMIT, None)
        .map_err(|error| BitbucketError::Keychain(error.to_string()))
}

pub fn keychain_read(method: Method) -> BitbucketResult<Option<String>> {
    let output = run(
        Command::new("security").args([
            "find-generic-password",
            "-s",
            TOKEN_SERVICE,
            "-a",
            method.account(),
            "-w",
        ]),
        None,
        KEYCHAIN_TIMEOUT,
    )?;
    if output.status.code() == Some(KEYCHAIN_NOT_FOUND) {
        return Ok(None);
    }
    if !output.status.success() {
        return Err(BitbucketError::Keychain(format!(
            "could not read the saved token: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    let secret = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok((!secret.is_empty()).then_some(secret))
}

/// `security -i` reads the command from stdin, so the token never shows up in
/// the process list the way an argument would.
pub fn keychain_write(method: Method, secret: &str) -> BitbucketResult<()> {
    let secret = validate_secret(secret)?;
    let line = format!(
        "add-generic-password -U -s {TOKEN_SERVICE} -a {} -w {secret}\n",
        method.account()
    );
    let output = run(
        Command::new("security").arg("-i"),
        Some(line.as_bytes()),
        KEYCHAIN_TIMEOUT,
    )?;
    if !output.status.success() {
        return Err(BitbucketError::Keychain(
            "the Keychain refused to save it".into(),
        ));
    }
    Ok(())
}

pub fn keychain_delete(method: Method) -> BitbucketResult<()> {
    run(
        Command::new("security").args([
            "delete-generic-password",
            "-s",
            TOKEN_SERVICE,
            "-a",
            method.account(),
        ]),
        None,
        KEYCHAIN_TIMEOUT,
    )?;
    Ok(())
}

/// Runs work that starts a process or touches the Keychain on a thread meant
/// for blocking, away from the few threads every plugin shares.
pub async fn blocking<T: Send + 'static>(
    work: Box<dyn FnOnce() -> BitbucketResult<T> + Send>,
) -> BitbucketResult<T> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| BitbucketError::Keychain(error.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_keep_the_characters_atlassian_puts_in_them() {
        assert!(validate_secret("ATATT3xFfGF0abc_def-ghi=A1B2C3D4").is_ok());
        assert!(validate_secret("a+b/c==").is_ok());
    }

    #[test]
    fn anything_that_could_end_the_keychain_command_early_is_refused() {
        for raw in ["", "   ", "two words", "a\nb", "a;b", "a\"b"] {
            assert!(validate_secret(raw).is_err(), "{raw:?}");
        }
    }

    #[test]
    fn nothing_saved_reads_as_signed_out() {
        let dir = std::env::temp_dir().join(format!("sikemux-bb-config-{}", std::process::id()));
        assert_eq!(load(&dir), BitbucketConfig::default());
        let saved = BitbucketConfig {
            method: Some(Method::Token),
            login: "someone".into(),
            email: Some("someone@example.com".into()),
        };
        save(&dir, &saved).expect("saves");
        assert_eq!(load(&dir), saved);
        std::fs::remove_dir_all(dir).ok();
    }
}

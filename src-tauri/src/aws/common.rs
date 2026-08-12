// Shared CLI plumbing for every AWS submodule.
//
//   run_aws_cli         — spawn `aws ...` with PAGER/COLOR scrubbed
//   aws_json            — run + parse stdout as JSON (sync)
//   classify_cli_err    — map stderr text → typed AppError
//   describe_in_chunks  — run N AWS calls in parallel, splitting `arns` into
//                         chunks (AWS describe-* commands cap at 10/100/etc)

use std::process::Command;
use std::time::Duration;

use futures::future::try_join_all;
use serde::de::DeserializeOwned;
use tokio::task;

use crate::bounded_process::{self, ProcessCancellation, ProcessRunError};
use crate::error::{AppError, AppResult};

const DESCRIBE_CHUNK_CONCURRENCY: usize = 4;
const AWS_COMMAND_TIMEOUT: Duration = Duration::from_secs(120);
const AWS_SSO_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const AWS_MAX_OUTPUT_BYTES: usize = 16 * 1024 * 1024;

pub(super) fn run_aws_cli(
    args: &[&str],
    profile: Option<&str>,
) -> AppResult<(bool, String, String)> {
    run_aws_cli_with_cancel(args, profile, None)
}

pub(super) fn run_aws_cli_with_cancel(
    args: &[&str],
    profile: Option<&str>,
    cancellation: Option<&ProcessCancellation>,
) -> AppResult<(bool, String, String)> {
    let bin = std::env::var("AWS_CLI").unwrap_or_else(|_| "aws".to_string());
    let mut cmd = Command::new(&bin);
    if let Some(p) = profile {
        cmd.env("AWS_PROFILE", p);
    }
    cmd.env("AWS_PAGER", "").env("NO_COLOR", "1");
    cmd.args(args);
    let timeout = if args.starts_with(&["sso", "login"]) {
        AWS_SSO_TIMEOUT
    } else {
        AWS_COMMAND_TIMEOUT
    };
    let out = bounded_process::run(&mut cmd, None, timeout, AWS_MAX_OUTPUT_BYTES, cancellation).map_err(|error| {
        if matches!(&error, ProcessRunError::Spawn(cause) if cause.kind() == std::io::ErrorKind::NotFound) {
            AppError::AwsCliMissing(bin.clone())
        } else {
            AppError::Aws(error.to_string())
        }
    })?;
    Ok((
        out.status.success(),
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    ))
}

pub(super) async fn run_aws_cli_cancellable_async(
    args: &[&str],
    profile: Option<&str>,
    cancellation: ProcessCancellation,
) -> AppResult<(bool, String, String)> {
    let profile = profile.map(String::from);
    let args: Vec<String> = args.iter().map(|s| (*s).to_string()).collect();
    task::spawn_blocking(move || {
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        run_aws_cli_with_cancel(&refs, profile.as_deref(), Some(&cancellation))
    })
    .await
    .map_err(|e| AppError::Other(format!("join error: {e}")))?
}

/// Map AWS CLI stderr text into a typed AppError.
///
/// Prefers structured JSON when the CLI ran `--output json` and surfaced
/// an error envelope (`{"Error": {"Code": "ExpiredToken", ...}}`). Falls
/// back to substring matching the human stderr when no structured form is
/// present — that's still the common case for client-side failures (e.g.
/// "Unable to locate credentials" emitted before any API call).
///
/// Localized here so callers don't repeat the mapping; if AWS changes the
/// wording, only this function moves.
pub(super) fn classify_cli_err(stderr: &str) -> AppError {
    // Structured form: AWS prints `An error occurred (Code) when calling
    // ...` for most service errors, sometimes also as a JSON envelope.
    // Try the latter first — it's stable across locales.
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(stderr.trim()) {
        let code = v
            .get("Error")
            .and_then(|e| e.get("Code"))
            .and_then(|c| c.as_str())
            .map(|s| s.to_ascii_lowercase());
        if let Some(c) = code {
            if c == "expiredtoken" || c == "expiredtokenexception" {
                return AppError::AwsTokenExpired;
            }
            if c == "credentialsnotfound" || c.contains("nocredential") {
                return AppError::AwsNoCredentials;
            }
        }
    }

    let s = stderr.to_lowercase();
    if s.contains("token has expired")
        || s.contains("sso session associated with this profile has expired")
        || s.contains("expiredtoken")
    {
        AppError::AwsTokenExpired
    } else if s.contains("could not be found") || s.contains("unable to locate credentials") {
        AppError::AwsNoCredentials
    } else {
        AppError::Aws(stderr.trim().to_string())
    }
}

/// Async wrapper around `run_aws_cli` for callers that already typed-match
/// on the (ok, stdout, stderr) tuple (auth path). Same off-thread pattern
/// as `aws_json_async`.
pub(super) async fn run_aws_cli_async(
    args: &[&str],
    profile: Option<&str>,
) -> AppResult<(bool, String, String)> {
    let profile = profile.map(String::from);
    let args: Vec<String> = args.iter().map(|s| (*s).to_string()).collect();
    task::spawn_blocking(move || {
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        run_aws_cli(&refs, profile.as_deref())
    })
    .await
    .map_err(|e| AppError::Other(format!("join error: {e}")))?
}

pub(super) fn aws_json<T: DeserializeOwned>(profile: &str, args: &[&str]) -> AppResult<T> {
    let (ok, stdout, stderr) = run_aws_cli(args, Some(profile))?;
    if !ok {
        return Err(classify_cli_err(&stderr));
    }
    serde_json::from_str::<T>(&stdout).map_err(AppError::Json)
}

/// Async wrapper — keeps blocking process spawn off the Tauri worker pool.
/// Every `#[tauri::command] pub async fn aws_*` should call this, not the
/// sync `aws_json`. Sync variant is retained for the internal callers
/// already running inside `task::spawn_blocking` (e.g. `describe_in_chunks`).
pub(super) async fn aws_json_async<T: DeserializeOwned + Send + 'static>(
    profile: &str,
    args: &[&str],
) -> AppResult<T> {
    let profile = profile.to_string();
    let args: Vec<String> = args.iter().map(|s| (*s).to_string()).collect();
    task::spawn_blocking(move || {
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        aws_json::<T>(&profile, &refs)
    })
    .await
    .map_err(|e| AppError::Other(format!("join error: {e}")))?
}

/// Run several `aws ... describe-X --<flag> <arns>` calls in parallel,
/// chunking `arns` into groups of `chunk_size`. Each chunk's response is
/// parsed into `R`; the per-chunk results are returned in input order.
///
/// `base_args` is the call prefix before the arns flag (e.g.
/// `["ecs", "describe-services", "--cluster", "<c>"]`).
/// `arns_flag` is the flag the arns are appended after (e.g. `"--services"`).
/// `tail_args` lands at the very end (typically `["--output", "json"]`).
pub(super) async fn describe_in_chunks<R: DeserializeOwned + Send + 'static>(
    profile: String,
    base_args: Vec<String>,
    arns_flag: &'static str,
    arns: Vec<String>,
    chunk_size: usize,
    tail_args: Vec<String>,
) -> AppResult<Vec<R>> {
    if arns.is_empty() {
        return Ok(Vec::new());
    }
    let chunk_size = chunk_size.max(1);
    let chunks: Vec<Vec<String>> = arns.chunks(chunk_size).map(|c| c.to_vec()).collect();

    let mut out = Vec::with_capacity(chunks.len());
    for batch in chunks.chunks(DESCRIBE_CHUNK_CONCURRENCY) {
        let futs = batch.iter().cloned().map(|chunk| {
            let profile = profile.clone();
            let base = base_args.clone();
            let tail = tail_args.clone();
            task::spawn_blocking(move || {
                let mut args: Vec<String> = base;
                args.push(arns_flag.to_string());
                args.extend(chunk);
                args.extend(tail);
                let refs: Vec<&str> = args.iter().map(String::as_str).collect();
                aws_json::<R>(&profile, &refs)
            })
        });

        let results = try_join_all(futs)
            .await
            .map_err(|e| AppError::Other(format!("join error: {e}")))?;
        out.extend(results.into_iter().collect::<AppResult<Vec<R>>>()?);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_substring_expired() {
        let e = classify_cli_err("An error occurred: token has expired blah");
        matches!(e, AppError::AwsTokenExpired);
    }

    #[test]
    fn classify_substring_no_credentials() {
        let e = classify_cli_err("Unable to locate credentials");
        matches!(e, AppError::AwsNoCredentials);
    }

    #[test]
    fn classify_structured_expired() {
        let body = r#"{"Error":{"Code":"ExpiredToken","Message":"x"}}"#;
        matches!(classify_cli_err(body), AppError::AwsTokenExpired);
    }

    #[test]
    fn classify_fallthrough() {
        match classify_cli_err("some weird error\n") {
            AppError::Aws(msg) => assert_eq!(msg, "some weird error"),
            _ => panic!("expected Aws variant"),
        }
    }
}

// Shared CLI plumbing for every AWS submodule.
//
//   run_aws_cli         — spawn `aws ...` with PAGER/COLOR scrubbed
//   aws_json            — run + parse stdout as JSON (sync)
//   classify_cli_err    — map stderr text → typed AppError
//   describe_in_chunks  — run N AWS calls in parallel, splitting `arns` into
//                         chunks (AWS describe-* commands cap at 10/100/etc)

use std::process::Command;

use futures::future::try_join_all;
use serde::de::DeserializeOwned;
use tokio::task;

use crate::error::{AppError, AppResult};

pub(super) fn run_aws_cli(
    args: &[&str],
    profile: Option<&str>,
) -> AppResult<(bool, String, String)> {
    let bin = std::env::var("AWS_CLI").unwrap_or_else(|_| "aws".to_string());
    let mut cmd = Command::new(&bin);
    if let Some(p) = profile {
        cmd.env("AWS_PROFILE", p);
    }
    cmd.env("AWS_PAGER", "").env("NO_COLOR", "1");
    cmd.args(args);
    let out = cmd.output().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            AppError::AwsCliMissing(bin.clone())
        } else {
            AppError::Io(e)
        }
    })?;
    Ok((
        out.status.success(),
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    ))
}

/// Map AWS CLI stderr text into a typed AppError. Substring matching is
/// localized here so callers don't repeat it; if AWS changes the wording,
/// only this function moves.
pub(super) fn classify_cli_err(stderr: &str) -> AppError {
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

pub(super) fn aws_json<T: DeserializeOwned>(profile: &str, args: &[&str]) -> AppResult<T> {
    let (ok, stdout, stderr) = run_aws_cli(args, Some(profile))?;
    if !ok {
        return Err(classify_cli_err(&stderr));
    }
    serde_json::from_str::<T>(&stdout).map_err(AppError::Json)
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
    let chunks: Vec<Vec<String>> = arns
        .chunks(chunk_size)
        .map(|c| c.to_vec())
        .collect();

    let futs = chunks.into_iter().map(|chunk| {
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
    results.into_iter().collect()
}

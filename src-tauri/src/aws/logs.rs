// CloudWatch logs live tail — `aws logs tail <group> --follow` streams new
// events to stdout indefinitely. Each tail is tracked by an integer id so
// the frontend can stop it explicitly when the user navigates away.
//
// Implementation: spawned as a `tokio::process::Child`, with stdout +
// stderr drained by tokio tasks (no dedicated OS threads). Each tail
// costs ~few KB of task state instead of two ~8 MB OS-thread stacks,
// which matters when the user has multiple log groups open at once or
// flips through ECS services that auto-attach a tail per service.

use std::process::Stdio;
use std::sync::atomic::{AtomicU32, Ordering};

use dashmap::DashMap;
use tauri::ipc::Channel;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

use crate::error::{AppError, AppResult};

#[derive(Default)]
pub struct LogsTailManager {
    pub(crate) tails: DashMap<u32, Child>,
}

static NEXT_TAIL_ID: AtomicU32 = AtomicU32::new(1);

#[tauri::command]
pub async fn aws_logs_tail_start(
    app: tauri::AppHandle,
    manager: tauri::State<'_, LogsTailManager>,
    profile: String,
    log_group: String,
    log_stream: Option<String>,
    since: Option<String>,
    on_line: Channel<String>,
) -> AppResult<u32> {
    let bin = std::env::var("AWS_CLI").unwrap_or_else(|_| "aws".to_string());
    let mut cmd = Command::new(&bin);
    cmd.env("AWS_PROFILE", &profile)
        .env("AWS_PAGER", "")
        .env("NO_COLOR", "1")
        // Critical: the AWS CLI's embedded Python detects pipe-not-TTY and
        // switches stdout to block buffering (~8 KB). Low-volume log streams
        // never fill that buffer, so our reader hangs and the UI just
        // shows "waiting for new ones". PYTHONUNBUFFERED=1 forces line-
        // buffered flushes so each event appears immediately.
        .env("PYTHONUNBUFFERED", "1")
        .arg("logs")
        .arg("tail")
        .arg(&log_group)
        .arg("--follow")
        .arg("--format")
        .arg("short");
    if let Some(stream) = &log_stream {
        cmd.arg("--log-stream-names").arg(stream);
    }
    cmd.arg("--since").arg(since.as_deref().unwrap_or("5m"));
    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Safety net: if the manager DashMap entry is dropped without
        // start_kill being called (panic, shutdown), the child still
        // gets SIGKILL on Drop instead of orphaning a `tail --follow`.
        .kill_on_drop(true);

    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            AppError::AwsCliMissing(bin.clone())
        } else {
            AppError::Io(e)
        }
    })?;
    let stdout = child.stdout.take().ok_or(AppError::BadArg("no stdout"))?;
    let stderr = child.stderr.take();
    let id = NEXT_TAIL_ID.fetch_add(1, Ordering::Relaxed);
    manager.tails.insert(id, child);

    // stdout — emit each line. Empty payload signals end-of-stream so the
    // UI can flip "live" → "ended". Tokio task = no OS thread per tail.
    //
    // Also: when this task ends (EOF, channel closed, child died), prune
    // the manager entry. Otherwise dead Children accumulate in the
    // DashMap until app shutdown — a slow leak across a session that
    // navigates through many ECS services.
    let line_ch = on_line.clone();
    let prune_app = app.clone();
    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            if line_ch.send(line).is_err() {
                break;
            }
        }
        let _ = line_ch.send(String::new());
        use tauri::Manager;
        if let Some(mgr) = prune_app.try_state::<LogsTailManager>() {
            mgr.tails.remove(&id);
        }
    });
    // stderr drain — surface failures (e.g. "log group does not exist") as
    // a prefixed line on the same channel so the user sees them.
    if let Some(stderr) = stderr {
        let line_ch = on_line.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                if line_ch.send(format!("[err] {}", line)).is_err() {
                    break;
                }
            }
        });
    }

    Ok(id)
}

#[tauri::command]
pub fn aws_logs_tail_stop(
    manager: tauri::State<'_, LogsTailManager>,
    id: u32,
) -> AppResult<()> {
    if let Some((_, mut child)) = manager.tails.remove(&id) {
        // start_kill is sync (just sends the signal); the actual reaping
        // happens when kill_on_drop fires on the Child's Drop, or when
        // tokio's signal handler reaps the zombie. Either way we don't
        // block the command thread.
        let _ = child.start_kill();
    }
    Ok(())
}

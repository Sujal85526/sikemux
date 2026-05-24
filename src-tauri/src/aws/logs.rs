// CloudWatch logs live tail — `aws logs tail <group> --follow` streams new
// events to stdout indefinitely. Spawn it, capture stdout line-by-line on a
// thread, ship each line through a Tauri Channel — same pattern as PTY
// output. Each tail is tracked by an integer id so the frontend can stop it
// explicitly when the user navigates away.

use std::io::{BufRead, BufReader};
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};

use dashmap::DashMap;
use tauri::ipc::Channel;

use crate::error::{AppError, AppResult};

#[derive(Default)]
pub struct LogsTailManager {
    pub(crate) tails: DashMap<u32, Child>,
}

static NEXT_TAIL_ID: AtomicU32 = AtomicU32::new(1);

#[tauri::command]
pub async fn aws_logs_tail_start(
    manager: tauri::State<'_, LogsTailManager>,
    profile: String,
    log_group: String,
    log_stream: Option<String>,
    since: Option<String>,
    on_line: Channel<String>,
) -> AppResult<u32> {
    let bin = std::env::var("AWS_CLI").unwrap_or_else(|_| "aws".to_string());
    let mut cmd = std::process::Command::new(&bin);
    cmd.env("AWS_PROFILE", &profile)
        .env("AWS_PAGER", "")
        .env("NO_COLOR", "1")
        // Critical: the AWS CLI's embedded Python detects pipe-not-TTY and
        // switches stdout to block buffering (~8 KB). Low-volume log streams
        // never fill that buffer, so our reader thread hangs and the UI just
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
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

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

    // Reader thread — emit each line. Empty payload signals end-of-stream
    // so the UI can flip "live" → "ended".
    let line_ch = on_line.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().flatten() {
            if line_ch.send(line).is_err() {
                break;
            }
        }
        let _ = line_ch.send(String::new());
    });
    // stderr drain — surface failures (e.g. "log group does not exist") as
    // a prefixed line on the same channel so the user sees them.
    if let Some(stderr) = stderr {
        let line_ch = on_line.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().flatten() {
                let _ = line_ch.send(format!("[err] {}", line));
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
        let _ = child.kill();
    }
    Ok(())
}

#[cfg(unix)]
use std::fs::File;
use std::io::Write;
#[cfg(unix)]
use std::os::fd::AsRawFd;
use std::time::{Duration, Instant};

use tauri::State;
#[cfg(unix)]
use tokio::io::unix::AsyncFd;

use crate::error::{AppError, AppResult};
use crate::observability::{global_observability, Metadata, SpanOutcome};

use super::agent_state::{arm_agent_activity, submits_line};
#[cfg(windows)]
use super::pty_size;
use super::{pty_err, validate_pty_dimensions, Pty, PtyManager};

/// Drive a non-blocking write to completion against a tokio `AsyncFd`.
/// Loops on EAGAIN via the readiness machinery; returns once every byte
/// has been written or the kernel reports an I/O error.
#[cfg(unix)]
async fn write_all_async(writer: &AsyncFd<File>, mut data: &[u8]) -> std::io::Result<()> {
    while !data.is_empty() {
        let mut guard = writer.writable().await?;
        let res = guard.try_io(|inner| {
            let mut f = inner.get_ref();
            f.write(data)
        });
        match res {
            Ok(Ok(0)) => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::WriteZero,
                    "pty write returned 0",
                ));
            }
            Ok(Ok(n)) => {
                data = &data[n..];
            }
            Ok(Err(e)) => return Err(e),
            Err(_would_block) => continue, // readiness cleared; loop
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn pty_write(manager: State<'_, PtyManager>, id: u32, data: String) -> AppResult<()> {
    let observer = global_observability();
    let operation =
        observer.slow_operation("pty.write", Duration::from_millis(8), None, Metadata::new());
    // Clone the Arc out of DashMap immediately so we don't hold a shard
    // across .await points (which would risk deadlocking the manager).
    let pty = manager
        .ptys
        .get(&id)
        .map(|r| r.clone())
        .ok_or(AppError::BadArg("pty not found"))?;
    if submits_line(&data) {
        arm_agent_activity(&pty);
    }
    #[cfg(unix)]
    // Serialise writers on the shared fd; the reader's readable() side is
    // unaffected and keeps draining concurrently.
    let _guard = {
        let wait_started = Instant::now();
        let guard = pty.write_lock.lock().await;
        observer.observe_latency("pty.write_lock_wait", wait_started.elapsed());
        guard
    };
    #[cfg(unix)]
    {
        let write_started = Instant::now();
        write_all_async(&pty.io, data.as_bytes())
            .await
            .map_err(AppError::from)?;
        observer.observe_latency("pty.os_write", write_started.elapsed());
    }
    #[cfg(windows)]
    tauri::async_runtime::spawn_blocking(move || {
        let mut writer = pty.writer.lock().map_err(pty_err)?;
        writer.write_all(data.as_bytes()).map_err(AppError::from)?;
        writer.flush().map_err(AppError::from)
    })
    .await
    .map_err(|e| AppError::Pty(format!("pty_write join: {e}")))??;
    operation.finish(SpanOutcome::Success);
    Ok(())
}

#[tauri::command]
pub async fn pty_resize(
    manager: State<'_, PtyManager>,
    id: u32,
    cols: u16,
    rows: u16,
) -> AppResult<()> {
    validate_pty_dimensions(cols, rows)?;
    let pty = manager
        .ptys
        .get(&id)
        .map(|entry| entry.value().clone())
        .ok_or(AppError::BadArg("pty not found"))?;
    tauri::async_runtime::spawn_blocking(move || resize_locked(&pty, cols, rows))
        .await
        .map_err(|e| AppError::Pty(format!("pty_resize join: {e}")))?
}

fn resize_locked(pty: &Pty, cols: u16, rows: u16) -> AppResult<()> {
    #[cfg(unix)]
    {
        // Resize via TIOCSWINSZ straight on the master fd (the kernel also
        // raises SIGWINCH on the foreground process group).
        let ws = libc::winsize {
            ws_row: rows,
            ws_col: cols,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
        // SAFETY: the fd belongs to `pty.io`, which stays open for this call, and `ws`
        // is a live winsize on the stack, the exact struct TIOCSWINSZ reads.
        let rc = unsafe {
            libc::ioctl(
                pty.io.get_ref().as_raw_fd(),
                libc::TIOCSWINSZ,
                &ws as *const _,
            )
        };
        if rc != 0 {
            return Err(pty_err(std::io::Error::last_os_error()));
        }
    }
    #[cfg(windows)]
    pty.master
        .lock()
        .map_err(pty_err)?
        .resize(pty_size(cols, rows))
        .map_err(pty_err)?;
    // Resize the parser too so the grid the snapshot returns matches the
    // xterm's geometry — otherwise re-attach lands on a mis-sized canvas.
    // `set_size` lives on the Screen, not the Parser itself.
    if let Ok(mut parser) = pty.parser.lock() {
        parser.screen_mut().set_size(rows, cols);
    }
    Ok(())
}

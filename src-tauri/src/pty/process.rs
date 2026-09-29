use std::sync::atomic::Ordering;
use std::time::Duration;

use portable_pty::Child;
use tauri::State;

use crate::error::{AppError, AppResult};

use super::task::{notify_task_process_exited, task_process_needs_force_backstop};
use super::PtyManager;

// Grace window between the SIGTERM and the SIGKILL backstop in `drain`.
// Long enough for a foreground program (editor, agent, build) to catch
// SIGTERM and flush; short enough that app quit / update-relaunch doesn't
// feel laggy. One shared window, not per-PTY — see `drain`.
pub(super) const DRAIN_GRACE: Duration = Duration::from_millis(250);

pub(super) fn child_process_id(child: &mut Box<dyn Child + Send + Sync>) -> Option<u32> {
    child.process_id()
}

#[cfg(unix)]
fn signal_process_group(pid: u32, signal: libc::c_int) {
    if pid == 0 {
        return;
    }
    // Negative pid targets the process group. portable_pty/forkpty makes the
    // shell the session/group leader on Unix; if that assumption ever fails,
    // Child::kill below still targets the direct child as a fallback.
    // SAFETY: kill only takes integers and touches no memory. pid is non-zero,
    // so this never becomes kill(0), which would signal our own process group.
    unsafe {
        libc::kill(-(pid as i32), signal);
    }
}

#[cfg(unix)]
pub(super) fn terminate_process_tree(pid: u32, force: bool) {
    signal_process_group(pid, if force { libc::SIGKILL } else { libc::SIGTERM });
}

#[cfg(windows)]
pub(super) fn terminate_process_tree(pid: u32, force: bool) {
    // ConPTY's portable child handle terminates only the direct shell. Use
    // taskkill's tree mode so foreground commands and agent subprocesses do
    // not survive an app close. Child::kill remains the fallback below.
    let mut command = std::process::Command::new("taskkill");
    let pid = pid.to_string();
    command.args(["/PID", &pid, "/T"]);
    if force {
        command.arg("/F");
    }
    let _ = command.status();
}

pub(super) fn kill_and_reap_child(
    child: &mut Box<dyn Child + Send + Sync>,
    pid: Option<u32>,
) -> Option<portable_pty::ExitStatus> {
    let _ = child.kill();
    if let Some(pid) = pid {
        terminate_process_tree(pid, true);
    }
    child.wait().ok()
}

fn terminate_and_reap_child(
    child: &mut Box<dyn Child + Send + Sync>,
    force_process_tree_after_grace: bool,
) -> Option<portable_pty::ExitStatus> {
    // For a task, do not reap an exited shell until after its process group
    // receives the force backstop: a descendant may still retain the PTY and
    // ignore SIGTERM. Non-task callers preserve the historical fast path.
    if !force_process_tree_after_grace {
        if let Ok(Some(status)) = child.try_wait() {
            return Some(status);
        }
    }
    let pid = child_process_id(child);
    if let Some(pid) = pid {
        terminate_process_tree(pid, false);
    }
    std::thread::sleep(DRAIN_GRACE);
    if force_process_tree_after_grace {
        if let Some(pid) = pid {
            terminate_process_tree(pid, true);
        }
    }
    if let Ok(Some(status)) = child.try_wait() {
        return Some(status);
    }
    kill_and_reap_child(child, pid)
}

/// Owns a freshly-spawned child until the fully-initialized `Pty` takes it.
/// Child handles do not kill on drop, so every fallible setup step after spawn
/// must be guarded explicitly.
pub(super) struct SpawnedChildGuard(Option<Box<dyn Child + Send + Sync>>);

impl SpawnedChildGuard {
    pub(super) fn new(child: Box<dyn Child + Send + Sync>) -> Self {
        Self(Some(child))
    }

    pub(super) fn into_inner(mut self) -> Box<dyn Child + Send + Sync> {
        self.0.take().expect("spawned child guard already empty")
    }
}

impl Drop for SpawnedChildGuard {
    fn drop(&mut self) {
        if let Some(mut child) = self.0.take() {
            let pid = child_process_id(&mut child);
            let _ = kill_and_reap_child(&mut child, pid);
        }
    }
}

#[tauri::command]
pub async fn pty_kill(manager: State<'_, PtyManager>, id: u32) -> AppResult<()> {
    let task = manager
        .ptys
        .get(&id)
        .and_then(|entry| entry.task_exit.as_ref().map(|_| entry.value().clone()));
    let target = task.or_else(|| manager.ptys.remove(&id).map(|(_, pty)| pty));
    if let Some(pty) = target {
        pty.report_exit.store(false, Ordering::Release);
        // Notify any remaining subscribers so their xterms render
        // "[process exited]" before the unmount tears them down.
        if let Ok(subs) = pty.subscribers.lock() {
            for subscriber in subs.values() {
                subscriber.send(&[]);
            }
        }
        // Killing without wait() leaves zombies. Do the potentially-slow
        // SIGTERM grace + SIGKILL backstop on the blocking pool, not on the
        // async runtime worker.
        tauri::async_runtime::spawn_blocking(move || {
            let status = if let Ok(mut child) = pty.child.lock() {
                // Read the completion stamp only after taking the child lock.
                // The natural waiter publishes it before releasing this lock,
                // closing the stale-pid race with a concurrent explicit kill.
                let force_task_tree = task_process_needs_force_backstop(
                    pty.task_exit.is_some(),
                    pty.task_exited_at_ms.load(Ordering::Acquire),
                );
                terminate_and_reap_child(&mut child, force_task_tree)
            } else {
                None
            };
            notify_task_process_exited(&pty, status.as_ref());
        })
        .await
        .map_err(|e| AppError::Pty(format!("pty_kill join: {e}")))?;
    }
    Ok(())
}

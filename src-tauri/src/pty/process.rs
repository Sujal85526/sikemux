use std::sync::atomic::Ordering;

use sikemux_pty::process::terminate_and_reap_child;
use sikemux_pty::task::task_process_needs_force_backstop;
use tauri::State;

use crate::error::{AppError, AppResult};

use super::task::notify_task_process_exited;
use super::PtyManager;

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

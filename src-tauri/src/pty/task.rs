use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use portable_pty::CommandBuilder;
use sikemux_pty::launch::{configure_pty_environment, PtyContext};
use sikemux_pty::output_log::{OutputPage, OutputQuery};
use sikemux_pty::shell::configure_task_command;
use sikemux_pty::task::{
    task_reclamation_plan, validate_task_request, TaskProcessExit, TaskRetentionCandidate,
    TaskSpawnRequest, MAX_RETAINED_EXITED_TASK_PTYS,
};
use sikemux_pty::user_shell::{configured_shell, login_shell_environment};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

use crate::error::AppResult;
use crate::observability::{global_observability, Metadata, SpanOutcome};

use super::spawn::{spawn_prepared_pty, PreparedPtyLaunch};
use super::{now_ms, Pty, PtyManager, PtyOwner};

pub(super) struct TaskExitReporter {
    channel: Channel<TaskProcessExit>,
    sent: AtomicBool,
}

impl TaskExitReporter {
    fn new(channel: Channel<TaskProcessExit>) -> Self {
        Self {
            channel,
            sent: AtomicBool::new(false),
        }
    }

    fn send_once(&self, status: Option<&portable_pty::ExitStatus>) -> bool {
        if self.sent.swap(true, Ordering::AcqRel) {
            return false;
        }
        let _ = self.channel.send(TaskProcessExit::from_status(status));
        true
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSpawnResult {
    pty_id: u32,
}

fn task_retention_candidate(pty: &Pty) -> Option<TaskRetentionCandidate> {
    pty.task_exit.as_ref()?;
    let has_subscribers = match pty.subscribers.lock() {
        Ok(subscribers) => !subscribers.is_empty(),
        Err(_) => return None,
    };
    Some(TaskRetentionCandidate {
        id: pty.id,
        exited_at_ms: pty.task_exited_at_ms.load(Ordering::Acquire),
        has_subscribers,
    })
}

pub(super) fn reclaim_completed_task_ptys(manager: &PtyManager, now: u64) {
    // Clone identities out of DashMap before taking subscriber locks. The
    // conditional removal below rechecks both the exact Arc and eligibility,
    // so a concurrent attach or wrapped/reused PTY id always wins safely.
    let snapshot: Vec<(u32, Arc<Pty>)> = manager
        .ptys
        .iter()
        .map(|entry| (*entry.key(), entry.value().clone()))
        .collect();
    let mut identities = HashMap::with_capacity(snapshot.len());
    let mut candidates = Vec::new();
    for (id, pty) in snapshot {
        if let Some(candidate) = task_retention_candidate(&pty) {
            identities.insert(id, pty);
            candidates.push(candidate);
        }
    }
    for id in task_reclamation_plan(candidates, now, MAX_RETAINED_EXITED_TASK_PTYS) {
        let Some(candidate) = identities.remove(&id) else {
            continue;
        };
        let _ = manager.ptys.remove_if(&id, |_, current| {
            Arc::ptr_eq(current, &candidate)
                && task_retention_candidate(current)
                    .is_some_and(|state| state.exited_at_ms != 0 && !state.has_subscribers)
        });
    }
}

pub(super) fn stamp_task_process_exited(pty: &Pty) -> Option<u64> {
    pty.task_exit.as_ref()?;
    let exited_at = now_ms().max(1);
    match pty
        .task_exited_at_ms
        .compare_exchange(0, exited_at, Ordering::AcqRel, Ordering::Acquire)
    {
        Ok(_) => {
            pty.last_activity_ms.store(exited_at, Ordering::Release);
            Some(exited_at)
        }
        Err(existing) => Some(existing),
    }
}

pub(super) fn notify_task_process_exited(pty: &Pty, status: Option<&portable_pty::ExitStatus>) {
    let Some(reporter) = pty.task_exit.as_ref() else {
        return;
    };
    let Some(exited_at) = stamp_task_process_exited(pty) else {
        return;
    };
    let first_delivery = reporter.send_once(status);
    // Enforce the count bound immediately rather than waiting for the periodic
    // sweeper: a storm of zero-duration tasks must not retain one parser per
    // completion for an entire sweep interval.
    if first_delivery {
        if let Some(manager) = pty.app.try_state::<PtyManager>() {
            reclaim_completed_task_ptys(&manager, exited_at);
        }
    }
}

#[tauri::command]
pub async fn task_spawn(
    app: AppHandle,
    manager: State<'_, PtyManager>,
    request: TaskSpawnRequest,
    on_exit: Channel<TaskProcessExit>,
) -> AppResult<TaskSpawnResult> {
    let paths = validate_task_request(&request)?;
    let TaskSpawnRequest {
        execution_id,
        terminal_key,
        task_id,
        label,
        project: _,
        source,
        command,
        cwd: _,
        env,
        cols,
        rows,
    } = request;

    let shell = configured_shell();
    let mut task_command = CommandBuilder::new(&shell);
    let context = PtyContext {
        session_id: execution_id.clone(),
        session_name: label,
        session_kind: "task".into(),
        project: Some(paths.project.to_string_lossy().into_owned()),
        window_id: None,
        pane_id: None,
        agent_id: None,
        agent_type: None,
        initial_prompt_submitted: false,
        shell_integration: false,
    };
    let owner = PtyOwner {
        project: context.project.clone(),
        task_execution_id: Some(execution_id.clone()),
        ..PtyOwner::default()
    };
    let cli_executable = crate::cli_server::cli_executable_path();
    let cli_endpoint = crate::cli_server::cli_endpoint_path();
    configure_pty_environment(
        &mut task_command,
        Some(&context),
        &app.package_info().version.to_string(),
        cli_executable.as_deref(),
        cli_endpoint.as_deref(),
        login_shell_environment(),
    );
    task_command.env("SIKEMUX_TASK_EXECUTION_ID", execution_id);
    task_command.env("SIKEMUX_TASK_TERMINAL_KEY", terminal_key);
    task_command.env("SIKEMUX_TASK_ID", task_id);
    task_command.env("SIKEMUX_TASK_SOURCE", source.as_str());
    for (key, value) in env {
        task_command.env(key, value);
    }
    task_command.cwd(paths.cwd);
    configure_task_command(&mut task_command, &shell, &command)?;

    let operation = global_observability().slow_operation(
        "pty.task_spawn",
        Duration::from_millis(50),
        None,
        Metadata::new(),
    );
    let result = spawn_prepared_pty(
        app,
        &manager,
        PreparedPtyLaunch {
            cols,
            rows,
            command: task_command,
            owner,
            context: None,
            shell_integration: None,
            task_exit: Some(TaskExitReporter::new(on_exit)),
        },
    )
    .await;
    operation.finish(if result.is_ok() {
        SpanOutcome::Success
    } else {
        SpanOutcome::Error
    });
    result.map(|pty_id| TaskSpawnResult { pty_id })
}

#[tauri::command]
pub async fn harness_task_output(
    manager: State<'_, PtyManager>,
    id: u32,
    query: OutputQuery,
) -> Result<OutputPage, String> {
    let pty = manager
        .ptys
        .get(&id)
        .map(|entry| entry.value().clone())
        .ok_or("Task output expired or task no longer exists")?;
    if pty.task_exit.is_none() {
        return Err("PTY is not a managed task".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        pty.harness_output
            .lock()
            .map_err(|_| "output lock poisoned".to_string())?
            .query(&query)
    })
    .await
    .map_err(|e| format!("harness_task_output join: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::{TaskExitReporter, TaskSpawnResult};
    use std::sync::{Arc, Mutex};

    #[test]
    fn task_exit_reporter_delivers_one_typed_exit_under_racing_completion_paths() {
        let messages = Arc::new(Mutex::new(Vec::new()));
        let received = messages.clone();
        let channel = tauri::ipc::Channel::new(move |body| {
            let value = body.deserialize::<serde_json::Value>()?;
            received.lock().expect("messages lock").push(value);
            Ok(())
        });
        let reporter = Arc::new(TaskExitReporter::new(channel));

        std::thread::scope(|scope| {
            for index in 0..16u32 {
                let reporter = reporter.clone();
                scope.spawn(move || {
                    let status = portable_pty::ExitStatus::with_exit_code(index);
                    reporter.send_once(Some(&status));
                });
            }
        });

        let messages = messages.lock().expect("messages lock");
        assert_eq!(messages.len(), 1);
        assert!(messages[0]["code"].as_u64().is_some());
        assert!(messages[0].get("signal").is_none());
    }

    #[test]
    fn task_spawn_result_is_exact() {
        assert_eq!(
            serde_json::to_value(TaskSpawnResult { pty_id: 42 }).expect("serialize spawn"),
            serde_json::json!({ "ptyId": 42 })
        );
    }
}

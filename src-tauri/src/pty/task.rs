use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use portable_pty::CommandBuilder;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

use crate::error::{AppError, AppResult};
use crate::observability::{global_observability, Metadata, SpanOutcome};

use super::launch::{configure_pty_environment, PtyContext};
use super::shell::configure_task_command;
use super::spawn::{spawn_prepared_pty, PreparedPtyLaunch};
use super::{now_ms, validate_pty_dimensions, Pty, PtyManager};

const MAX_TASK_EXECUTION_ID_BYTES: usize = 8 * 1024;
const MAX_TASK_TERMINAL_KEY_BYTES: usize = 8 * 1024;
const MAX_TASK_ID_BYTES: usize = 128;
const MAX_TASK_LABEL_BYTES: usize = 256;
const MAX_TASK_PROJECT_BYTES: usize = 4 * 1024;
const MAX_TASK_COMMAND_BYTES: usize = 16 * 1024;
const MAX_TASK_CWD_BYTES: usize = 4 * 1024;
const MAX_TASK_ENV_ENTRIES: usize = 128;
const MAX_TASK_ENV_KEY_BYTES: usize = 256;
const MAX_TASK_ENV_VALUE_BYTES: usize = 8 * 1024;
const MAX_TASK_ENV_TOTAL_BYTES: usize = 64 * 1024;
const MAX_TASK_SIGNAL_BYTES: usize = 128;
const TASK_EXIT_RETENTION: Duration = Duration::from_secs(10 * 60);
const MAX_RETAINED_EXITED_TASK_PTYS: usize = 128;

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
enum TaskSource {
    BuiltIn,
    Project,
    Recent,
}

impl TaskSource {
    fn as_str(self) -> &'static str {
        match self {
            Self::BuiltIn => "built-in",
            Self::Project => "project",
            Self::Recent => "recent",
        }
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskSpawnRequest {
    execution_id: String,
    terminal_key: String,
    task_id: String,
    label: String,
    project: String,
    source: TaskSource,
    command: String,
    cwd: String,
    env: HashMap<String, String>,
    cols: u16,
    rows: u16,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskProcessExit {
    code: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    signal: Option<String>,
}

impl TaskProcessExit {
    fn from_status(status: Option<&portable_pty::ExitStatus>) -> Self {
        let signal = status
            .and_then(portable_pty::ExitStatus::signal)
            .and_then(|signal| {
                let mut remaining = MAX_TASK_SIGNAL_BYTES;
                let bounded = signal
                    .chars()
                    .filter(|character| !character.is_control())
                    .take_while(|character| {
                        let bytes = character.len_utf8();
                        if bytes > remaining {
                            return false;
                        }
                        remaining -= bytes;
                        true
                    })
                    .collect::<String>();
                (!bounded.is_empty()).then_some(bounded)
            });
        Self {
            code: status.map_or(1, portable_pty::ExitStatus::exit_code),
            signal,
        }
    }
}

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

struct ValidatedTaskPaths {
    project: PathBuf,
    cwd: PathBuf,
}

fn valid_task_text(value: &str, max_bytes: usize, require_trimmed: bool) -> bool {
    !value.is_empty()
        && value.len() <= max_bytes
        && !value.trim().is_empty()
        && (!require_trimmed || value.trim() == value)
        && !value.chars().any(char::is_control)
}

fn valid_task_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_TASK_ID_BYTES
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric() || (index > 0 && matches!(byte, b'.' | b'_' | b':' | b'-'))
        })
        && !matches!(value, "__proto__" | "constructor" | "prototype")
}

fn validate_task_environment(
    environment: &HashMap<String, String>,
    windows: bool,
) -> AppResult<()> {
    if environment.len() > MAX_TASK_ENV_ENTRIES {
        return Err(AppError::BadArg("task environment has too many entries"));
    }
    let mut total_bytes = 0usize;
    let mut normalized_keys = HashSet::with_capacity(environment.len());
    for (key, value) in environment {
        if key.is_empty()
            || key.len() > MAX_TASK_ENV_KEY_BYTES
            || key.contains('=')
            || key.chars().any(char::is_control)
            || matches!(key.as_str(), "__proto__" | "constructor" | "prototype")
        {
            return Err(AppError::BadArg("task environment contains an invalid key"));
        }
        if value.len() > MAX_TASK_ENV_VALUE_BYTES || value.contains('\0') {
            return Err(AppError::BadArg(
                "task environment contains an invalid value",
            ));
        }
        let normalized = if windows {
            key.to_lowercase()
        } else {
            key.clone()
        };
        if !normalized_keys.insert(normalized) {
            return Err(AppError::BadArg("task environment contains duplicate keys"));
        }
        total_bytes = total_bytes
            .checked_add(key.len())
            .and_then(|total| total.checked_add(value.len()))
            .ok_or(AppError::BadArg("task environment is too large"))?;
        if total_bytes > MAX_TASK_ENV_TOTAL_BYTES {
            return Err(AppError::BadArg("task environment is too large"));
        }
    }
    Ok(())
}

fn validate_task_request(request: &TaskSpawnRequest) -> AppResult<ValidatedTaskPaths> {
    if !valid_task_text(&request.execution_id, MAX_TASK_EXECUTION_ID_BYTES, true) {
        return Err(AppError::BadArg("invalid task execution id"));
    }
    if !valid_task_text(&request.terminal_key, MAX_TASK_TERMINAL_KEY_BYTES, true) {
        return Err(AppError::BadArg("invalid task terminal key"));
    }
    if !valid_task_id(&request.task_id) {
        return Err(AppError::BadArg("invalid task id"));
    }
    if !valid_task_text(&request.label, MAX_TASK_LABEL_BYTES, true) {
        return Err(AppError::BadArg("invalid task label"));
    }
    if !valid_task_text(&request.project, MAX_TASK_PROJECT_BYTES, false)
        || !Path::new(&request.project).is_absolute()
    {
        return Err(AppError::BadArg("invalid task project"));
    }
    if request.command.is_empty()
        || request.command.len() > MAX_TASK_COMMAND_BYTES
        || request.command.trim().is_empty()
        || request.command.contains('\0')
    {
        return Err(AppError::BadArg("invalid task command"));
    }
    if !valid_task_text(&request.cwd, MAX_TASK_CWD_BYTES, false)
        || !Path::new(&request.cwd).is_absolute()
    {
        return Err(AppError::BadArg("invalid task working directory"));
    }
    validate_pty_dimensions(request.cols, request.rows)?;
    validate_task_environment(&request.env, cfg!(windows))?;
    let project = std::fs::canonicalize(&request.project)
        .map_err(|_| AppError::BadArg("invalid task project"))?;
    if !project.is_dir() {
        return Err(AppError::BadArg("invalid task project"));
    }
    let cwd = std::fs::canonicalize(&request.cwd)
        .map_err(|_| AppError::BadArg("invalid task working directory"))?;
    if !cwd.is_dir() || !cwd.starts_with(&project) {
        return Err(AppError::BadArg(
            "task working directory must be inside its project",
        ));
    }
    Ok(ValidatedTaskPaths { project, cwd })
}

fn task_retention_elapsed(exited_at_ms: u64, now_ms: u64, has_subscribers: bool) -> bool {
    exited_at_ms != 0
        && !has_subscribers
        && now_ms.saturating_sub(exited_at_ms) >= TASK_EXIT_RETENTION.as_millis() as u64
}

pub(super) fn should_signal_process_on_drain(is_task: bool, task_exited_at_ms: u64) -> bool {
    !is_task || task_exited_at_ms == 0
}

pub(super) fn task_process_needs_force_backstop(is_task: bool, task_exited_at_ms: u64) -> bool {
    is_task && task_exited_at_ms == 0
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct TaskRetentionCandidate {
    id: u32,
    exited_at_ms: u64,
    has_subscribers: bool,
}

fn task_reclamation_plan(
    mut candidates: Vec<TaskRetentionCandidate>,
    now: u64,
    max_retained: usize,
) -> Vec<u32> {
    candidates.retain(|candidate| candidate.exited_at_ms != 0 && !candidate.has_subscribers);
    candidates.sort_unstable_by_key(|candidate| (candidate.exited_at_ms, candidate.id));
    let excess = candidates.len().saturating_sub(max_retained);
    candidates
        .into_iter()
        .enumerate()
        .filter_map(|(index, candidate)| {
            (index < excess || task_retention_elapsed(candidate.exited_at_ms, now, false))
                .then_some(candidate.id)
        })
        .collect()
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

    let shell = crate::system::configured_shell();
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
    let cli_executable = crate::cli_server::cli_executable_path();
    let cli_endpoint = crate::cli_server::cli_endpoint_path();
    configure_pty_environment(
        &mut task_command,
        Some(&context),
        &app.package_info().version.to_string(),
        cli_executable.as_deref(),
        cli_endpoint.as_deref(),
        crate::system::login_shell_environment(),
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
    query: crate::harness::OutputQuery,
) -> Result<crate::harness::OutputPage, String> {
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
    use super::{
        should_signal_process_on_drain, task_process_needs_force_backstop, task_reclamation_plan,
        task_retention_elapsed, validate_task_environment, validate_task_request, TaskExitReporter,
        TaskProcessExit, TaskRetentionCandidate, TaskSource, TaskSpawnRequest, TaskSpawnResult,
        MAX_RETAINED_EXITED_TASK_PTYS, MAX_TASK_COMMAND_BYTES, MAX_TASK_ENV_ENTRIES,
        MAX_TASK_ENV_TOTAL_BYTES, TASK_EXIT_RETENTION,
    };
    use crate::pty::{validate_pty_dimensions, MAX_PTY_DIMENSION};
    use std::collections::HashMap;
    use std::path::Path;
    use std::sync::{Arc, Mutex};

    fn task_request(cwd: &Path) -> TaskSpawnRequest {
        TaskSpawnRequest {
            execution_id: "[\"task\",1]".into(),
            terminal_key: "[\"task\",\"/repo\",\"test\"]".into(),
            task_id: "test:unit".into(),
            label: "Unit tests".into(),
            project: cwd.to_string_lossy().into_owned(),
            source: TaskSource::Project,
            command: "printf '%s' \"$TOKEN\"".into(),
            cwd: cwd.to_string_lossy().into_owned(),
            env: HashMap::from([("TOKEN".into(), "not-logged".into())]),
            cols: 120,
            rows: 40,
        }
    }

    #[test]
    fn terminal_geometry_is_strict_and_shared_with_tasks() {
        assert!(validate_pty_dimensions(1, 1).is_ok());
        assert!(validate_pty_dimensions(MAX_PTY_DIMENSION, MAX_PTY_DIMENSION).is_ok());
        for (cols, rows) in [
            (0, 1),
            (1, 0),
            (MAX_PTY_DIMENSION + 1, 1),
            (1, MAX_PTY_DIMENSION + 1),
        ] {
            assert!(validate_pty_dimensions(cols, rows).is_err());
        }

        let directory = tempfile::tempdir().expect("task cwd");
        let mut request = task_request(directory.path());
        request.cols = MAX_PTY_DIMENSION;
        request.rows = MAX_PTY_DIMENSION;
        validate_task_request(&request).expect("shared maximum is valid for tasks");
        request.rows = MAX_PTY_DIMENSION + 1;
        assert!(validate_task_request(&request).is_err());
    }

    #[test]
    fn task_request_is_camel_case_bounded_and_requires_a_real_absolute_cwd() {
        let directory = tempfile::tempdir().expect("task cwd");
        let value = serde_json::json!({
            "executionId": "[\"task\",1]",
            "terminalKey": "[\"task\",\"repo\",\"check\"]",
            "taskId": "check:all",
            "label": "Check all",
            "project": directory.path(),
            "source": "built-in",
            "command": "cargo test\nprintf done",
            "cwd": directory.path(),
            "env": { "TOKEN": "secret\nvalue" },
            "cols": 132,
            "rows": 43
        });
        let request: TaskSpawnRequest =
            serde_json::from_value(value.clone()).expect("deserialize task request");
        validate_task_request(&request).expect("valid task request");
        assert_eq!(request.source, TaskSource::BuiltIn);

        let mut unknown = value;
        unknown["unexpected"] = serde_json::Value::Bool(true);
        assert!(serde_json::from_value::<TaskSpawnRequest>(unknown).is_err());

        let mut invalid = task_request(directory.path());
        invalid.task_id = "bad/id".into();
        assert!(validate_task_request(&invalid).is_err());
        invalid = task_request(directory.path());
        invalid.command = "\0".repeat(MAX_TASK_COMMAND_BYTES);
        assert!(validate_task_request(&invalid).is_err());
        invalid = task_request(directory.path());
        invalid.cwd = "relative/path".into();
        assert!(validate_task_request(&invalid).is_err());
        invalid = task_request(directory.path());
        invalid.cols = 0;
        assert!(validate_task_request(&invalid).is_err());
    }

    #[test]
    fn task_environment_caps_entries_bytes_and_windows_aliases_without_exposing_values() {
        let too_many = (0..=MAX_TASK_ENV_ENTRIES)
            .map(|index| (format!("KEY_{index}"), String::new()))
            .collect();
        assert!(validate_task_environment(&too_many, false).is_err());

        let oversized = (0..9)
            .map(|index| {
                (
                    format!("KEY_{index}"),
                    "x".repeat(MAX_TASK_ENV_TOTAL_BYTES / 8),
                )
            })
            .collect();
        assert!(validate_task_environment(&oversized, false).is_err());

        let aliases = HashMap::from([("Path".into(), "one".into()), ("PATH".into(), "two".into())]);
        validate_task_environment(&aliases, false).expect("Unix keys are case-sensitive");
        assert!(validate_task_environment(&aliases, true).is_err());
        let unicode_aliases = HashMap::from([
            ("Ä_KEY".into(), "one".into()),
            ("ä_key".into(), "two".into()),
        ]);
        assert!(validate_task_environment(&unicode_aliases, true).is_err());

        for key in ["BAD=KEY", "bad\nkey", "__proto__"] {
            assert!(validate_task_environment(
                &HashMap::from([(key.into(), "value".into())]),
                false
            )
            .is_err());
        }
    }

    #[test]
    fn completed_task_retention_has_exact_grace_and_subscriber_boundaries() {
        let grace = TASK_EXIT_RETENTION.as_millis() as u64;
        assert!(!task_retention_elapsed(0, u64::MAX, false));
        assert!(!task_retention_elapsed(100, 100 + grace - 1, false));
        assert!(task_retention_elapsed(100, 100 + grace, false));
        assert!(!task_retention_elapsed(100, 100 + grace, true));
        assert!(!task_retention_elapsed(500, 100, false));
    }

    #[test]
    fn completed_task_reclamation_is_age_and_cardinality_bounded() {
        let grace = TASK_EXIT_RETENTION.as_millis() as u64;
        let now = grace + 1_000;
        let candidate = |id, exited_at_ms, has_subscribers| TaskRetentionCandidate {
            id,
            exited_at_ms,
            has_subscribers,
        };

        // Running and attached tasks are never part of the reclaimable pool.
        // Two expired entries are removed even though only one entry exceeds
        // the cap; the remaining three exactly fill it.
        let plan = task_reclamation_plan(
            vec![
                candidate(9, now - 100, false),
                candidate(1, 1, false),
                candidate(8, now - 200, true),
                candidate(2, 500, false),
                candidate(7, 0, false),
                candidate(4, now - 300, false),
                candidate(3, now - 400, false),
            ],
            now,
            3,
        );
        assert_eq!(plan, vec![1, 2]);

        // Equal completion times use PTY id as a deterministic tie-breaker.
        assert_eq!(
            task_reclamation_plan(
                vec![candidate(9, now, false), candidate(3, now, false)],
                now,
                1,
            ),
            vec![3]
        );

        let fixed_cap = (1..=(MAX_RETAINED_EXITED_TASK_PTYS as u32 + 1))
            .map(|id| candidate(id, now, false))
            .collect();
        assert_eq!(
            task_reclamation_plan(fixed_cap, now, MAX_RETAINED_EXITED_TASK_PTYS),
            vec![1]
        );
    }

    #[test]
    fn drain_never_signals_a_retained_completed_task_pid() {
        assert!(should_signal_process_on_drain(false, 0));
        assert!(should_signal_process_on_drain(false, 42));
        assert!(should_signal_process_on_drain(true, 0));
        assert!(!should_signal_process_on_drain(true, 42));
        assert!(!task_process_needs_force_backstop(false, 0));
        assert!(task_process_needs_force_backstop(true, 0));
        assert!(!task_process_needs_force_backstop(true, 42));
    }

    #[test]
    fn task_cwd_must_resolve_inside_the_real_project_directory() {
        let root = tempfile::tempdir().expect("task roots");
        let project = root.path().join("project");
        let nested = project.join("packages/app");
        let outside = root.path().join("outside");
        std::fs::create_dir_all(&nested).expect("nested task cwd");
        std::fs::create_dir(&outside).expect("outside task cwd");

        let mut request = task_request(&project);
        request.cwd = nested.to_string_lossy().into_owned();
        let paths = validate_task_request(&request).expect("nested cwd is valid");
        assert_eq!(
            paths.project,
            project.canonicalize().expect("canonical project")
        );
        assert_eq!(paths.cwd, nested.canonicalize().expect("canonical cwd"));

        request.cwd = outside.to_string_lossy().into_owned();
        assert!(validate_task_request(&request).is_err());

        let file = project.join("not-a-directory");
        std::fs::write(&file, b"file").expect("project file");
        request.cwd = file.to_string_lossy().into_owned();
        assert!(validate_task_request(&request).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn task_cwd_cannot_symlink_escape_the_project() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().expect("task roots");
        let project = root.path().join("project");
        let outside = root.path().join("outside");
        std::fs::create_dir(&project).expect("project");
        std::fs::create_dir(&outside).expect("outside");
        let escaped = project.join("escaped");
        symlink(&outside, &escaped).expect("escaped cwd symlink");

        let mut request = task_request(&project);
        request.cwd = escaped.to_string_lossy().into_owned();
        assert!(validate_task_request(&request).is_err());
    }

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
    fn task_wire_results_are_exact_and_signal_is_optional() {
        assert_eq!(
            serde_json::to_value(TaskSpawnResult { pty_id: 42 }).expect("serialize spawn"),
            serde_json::json!({ "ptyId": 42 })
        );
        assert_eq!(
            serde_json::to_value(TaskProcessExit::from_status(Some(
                &portable_pty::ExitStatus::with_exit_code(0)
            )))
            .expect("serialize success"),
            serde_json::json!({ "code": 0 })
        );
        assert_eq!(
            serde_json::to_value(TaskProcessExit::from_status(Some(
                &portable_pty::ExitStatus::with_signal("SIGTERM")
            )))
            .expect("serialize signal"),
            serde_json::json!({ "code": 1, "signal": "SIGTERM" })
        );
    }
}

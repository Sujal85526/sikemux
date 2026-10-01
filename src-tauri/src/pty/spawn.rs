use std::collections::HashMap;
#[cfg(unix)]
use std::fs::File;
use std::io::Read;
#[cfg(unix)]
use std::os::fd::FromRawFd;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};

use portable_pty::{CommandBuilder, NativePtySystem, PtySystem};
use tauri::{AppHandle, Manager, State};
#[cfg(unix)]
use tokio::io::unix::AsyncFd;

use crate::agent_detection::AgentKind;
use crate::error::{AppError, AppResult};
use crate::observability::global_observability;

use super::agent_state::publish_agent_state;
use super::launch::{
    apply_agent_profile, configure_interactive_command, configure_pty_environment,
    validate_direct_command, PtyContext, PtyDirectCommand,
};
use super::output::{
    await_subscriber_credit, broadcast_output, forgive_unacked, notify_process_exited,
    subscribers_over_budget,
};
use super::process::SpawnedChildGuard;
use super::screen::semantic_parser_with_shell;
use super::shell::{
    configure_shell_integration, inherited_ssh_environment, shell_integration_requested,
    ShellLaunchIntegration,
};
#[cfg(unix)]
use super::shell::{shell_wants_login_flag, startup_bootstrap};
use super::sweeper::ensure_sweeper;
use super::task::{reclaim_completed_task_ptys, stamp_task_process_exited, TaskExitReporter};
use super::{
    now_ms, pty_err, pty_size, validate_pty_dimensions, Pty, PtyManager, PtyOwner, ACTIVITY_IDLE,
    ACTIVITY_UNKNOWN, ACTIVITY_WORKING, MAX_PTY_ID_COLLISION_PROBES, NEXT_PTY_ID, OUTPUT_READS,
    PARSER_SCROLLBACK,
};
#[cfg(unix)]
use super::{OUTPUT_BATCH_BYTES, OUTPUT_COALESCE};

fn allocate_pty_id(manager: &PtyManager) -> AppResult<u32> {
    for _ in 0..MAX_PTY_ID_COLLISION_PROBES {
        let id = NEXT_PTY_ID.fetch_add(1, Ordering::Relaxed);
        if id != 0 && !manager.ptys.contains_key(&id) {
            return Ok(id);
        }
    }
    Err(AppError::Pty("PTY id capacity exhausted".into()))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn pty_spawn(
    app: AppHandle,
    manager: State<'_, PtyManager>,
    browser: State<'_, crate::browser::BrowserManager>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    startup: Option<String>,
    direct_command: Option<PtyDirectCommand>,
    context: Option<PtyContext>,
) -> AppResult<u32> {
    validate_pty_dimensions(cols, rows)?;
    let startup = startup.filter(|value| !value.is_empty());
    let mut direct_command = direct_command;
    if startup.is_some() && direct_command.is_some() {
        return Err(AppError::BadArg(
            "PTY startup and direct command are mutually exclusive",
        ));
    }
    if let Some(command) = direct_command.as_ref() {
        validate_direct_command(command, context.as_ref())?;
    }
    let agent_launch = match (direct_command.as_ref(), context.as_ref()) {
        (Some(command), Some(context)) => {
            match (context.agent_type.clone(), context.project.clone()) {
                (Some(agent), Some(project)) => {
                    let resumed = crate::activity::resumed_session_in_args(&agent, &command.args)
                        .map(str::to_string);
                    let config_path = command
                        .profile
                        .as_ref()
                        .and_then(|profile| profile.config_path.clone());
                    Some((agent, project, resumed, config_path))
                }
                _ => None,
            }
        }
        _ => None,
    };
    // An agent can only reach the browser tools if its own host is told they
    // exist, and every host is told differently (see browser::agents). A host
    // that cannot be told still launches, without them.
    let browser_environment = match (direct_command.as_mut(), context.as_ref()) {
        (Some(command), Some(context)) => {
            match (context.agent_id.as_deref(), context.agent_type.as_deref()) {
                (Some(agent_id), Some(agent_type))
                    if crate::browser::agents::is_supported(agent_type) =>
                {
                    match browser
                        .agent_integration(&app, agent_id, agent_type, &command.program)
                        .await
                    {
                        Ok(integration) => Some(integration.apply(&mut command.args)),
                        Err(error) => {
                            eprintln!("Sikemux browser integration is unavailable: {error}");
                            None
                        }
                    }
                }
                _ => None,
            }
        }
        _ => None,
    };
    let shell = crate::system::configured_shell();
    let direct_profile = direct_command
        .as_ref()
        .and_then(|command| command.profile.clone());
    #[cfg(unix)]
    let has_direct_command = direct_command.is_some();
    let mut cmd = CommandBuilder::new(&shell);
    if let Some(command) = direct_command.as_ref() {
        configure_interactive_command(&mut cmd, &shell, command);
    }
    let cli_executable = crate::cli_server::cli_executable_path();
    let cli_endpoint = crate::cli_server::cli_endpoint_path();
    configure_pty_environment(
        &mut cmd,
        context.as_ref(),
        &app.package_info().version.to_string(),
        cli_executable.as_deref(),
        cli_endpoint.as_deref(),
        &HashMap::new(),
    );
    apply_agent_profile(&mut cmd, context.as_ref(), direct_profile.as_ref());
    if let Some(environment) = browser_environment {
        for (key, value) in environment {
            cmd.env(key, value);
        }
    }
    #[cfg(windows)]
    if direct_command.is_none() {
        cmd.arg("-NoLogo");
    }
    let shell_integration = if shell_integration_requested(
        context.as_ref(),
        startup.is_some(),
        inherited_ssh_environment(),
    ) {
        match configure_shell_integration(&mut cmd, &shell) {
            Ok(integration) => integration,
            Err(_) => {
                // Shell integration is an enhancement, never a reason to lose
                // the user's terminal. Record only a count; setup errors can
                // contain temporary paths and must not enter trace metadata.
                let _ = global_observability()
                    .increment_counter("pty.shell_integration.setup_errors", 1);
                None
            }
        }
    } else {
        None
    };
    let cwd = cwd.unwrap_or_else(|| crate::system::user_home().to_string_lossy().into_owned());
    cmd.cwd(cwd);
    // Terminal, Ghostty and Alacritty all start a login shell, which is how
    // /etc/zprofile and ~/.zprofile get read — on macOS that is where
    // path_helper builds PATH. Without it the shell came up missing both the
    // user's profile and half their PATH.
    #[cfg(unix)]
    let login_shell = shell_wants_login_flag(&shell);
    #[cfg(unix)]
    if login_shell && startup.is_none() && !has_direct_command {
        cmd.arg("-l");
    }
    if let Some(startup) = startup.as_deref() {
        #[cfg(unix)]
        {
            cmd.env("SIKEMUX_SHELL", &shell);
            cmd.arg("-c");
            cmd.arg(startup_bootstrap(startup, login_shell));
        }
        #[cfg(windows)]
        {
            // -NoExit runs the requested startup action and then leaves the
            // user at a normal interactive PowerShell prompt.
            cmd.args(["-NoExit", "-Command", startup]);
        }
    }

    let id = spawn_prepared_pty(
        app,
        &manager,
        PreparedPtyLaunch {
            cols,
            rows,
            command: cmd,
            owner: PtyOwner::from_context(context.as_ref()),
            context,
            shell_integration,
            task_exit: None,
        },
    )
    .await?;
    if let Some((agent, project, resumed, config_path)) = agent_launch {
        tauri::async_runtime::spawn_blocking(move || {
            crate::activity::record_launch(
                &agent,
                &project,
                "terminal",
                resumed.as_deref(),
                config_path.as_deref(),
            )
        });
    }
    Ok(id)
}

pub(super) struct PreparedPtyLaunch {
    pub(super) cols: u16,
    pub(super) rows: u16,
    pub(super) command: CommandBuilder,
    pub(super) owner: PtyOwner,
    pub(super) context: Option<PtyContext>,
    pub(super) shell_integration: Option<ShellLaunchIntegration>,
    pub(super) task_exit: Option<TaskExitReporter>,
}

pub(super) async fn spawn_prepared_pty(
    app: AppHandle,
    manager: &PtyManager,
    launch: PreparedPtyLaunch,
) -> AppResult<u32> {
    validate_pty_dimensions(launch.cols, launch.rows)?;
    // Reclaim eligible completed tasks before applying the hard process/parser
    // budget, then reserve capacity before any OS handle or child is created.
    reclaim_completed_task_ptys(manager, now_ms());
    let capacity_permit = manager.capacity.try_acquire()?;
    ensure_sweeper(app.clone());
    // Has to run inside Tauri's tokio runtime — both `AsyncFd::new` and
    // `tokio::spawn` below panic when there is no reactor.
    let pair = NativePtySystem::default()
        .openpty(pty_size(launch.cols, launch.rows))
        .map_err(pty_err)?;
    let PreparedPtyLaunch {
        cols,
        rows,
        command,
        owner,
        context,
        shell_integration,
        task_exit,
    } = launch;
    let shell_metadata_enabled = shell_integration.is_some();

    let child = pair.slave.spawn_command(command).map_err(pty_err)?;
    let pid = child.process_id();
    let child = SpawnedChildGuard::new(child);
    drop(pair.slave);

    #[cfg(unix)]
    // Get the master fd and set the underlying open-file-description to
    // O_NONBLOCK. This is shared across every dup of the master (a
    // property of the file description, not the fd), which is exactly
    // what we need: the reader and writer dups below inherit it, and the
    // master fd itself only ever sees ioctl (resize) — unaffected by
    // O_NONBLOCK.
    let master_fd = pair
        .master
        .as_raw_fd()
        .ok_or_else(|| pty_err("master pty has no fd"))?;
    #[cfg(unix)]
    // SAFETY: `pair.master` still owns `master_fd` here, so the fd is open, and
    // F_GETFL/F_SETFL only read and set the fd's flags without touching memory.
    unsafe {
        let flags = libc::fcntl(master_fd, libc::F_GETFL);
        if flags < 0 {
            return Err(pty_err(std::io::Error::last_os_error()));
        }
        // O_NONBLOCK lives on the open-file-description, so the dup below
        // inherits it — one fd, both directions, never blocking.
        if libc::fcntl(master_fd, libc::F_SETFL, flags | libc::O_NONBLOCK) < 0 {
            return Err(pty_err(std::io::Error::last_os_error()));
        }
    }

    // ONE fd per PTY (was three). dup() the master once, then drop
    // portable_pty's `MasterPty`: that closes the fd it owned, but our dup
    // refers to the SAME kernel open-file-description, so the master end
    // stays open and the child keeps its controlling terminal (no SIGHUP).
    // The single `AsyncFd` services both reads and writes; resize is an
    // ioctl on this fd. At ~50+ live shells this is the difference between
    // ~150 fds and ~50 — the headroom that keeps a heavy session off the
    // process fd limit.
    #[cfg(unix)]
    // SAFETY: `pair.master` is not dropped until after this line, so `master_fd`
    // is still open; dup only creates a new fd and touches no memory.
    let dup_fd = unsafe { libc::dup(master_fd) };
    #[cfg(unix)]
    if dup_fd < 0 {
        return Err(pty_err(std::io::Error::last_os_error()));
    }
    #[cfg(unix)]
    drop(pair.master);
    #[cfg(unix)]
    // SAFETY: `dup_fd` was just created and checked above, and nothing else holds
    // it, so the File becomes its only owner and closes it exactly once.
    let io_file = unsafe { File::from_raw_fd(dup_fd) };
    #[cfg(windows)]
    let mut reader = pair.master.try_clone_reader().map_err(pty_err)?;
    #[cfg(windows)]
    let writer = pair.master.take_writer().map_err(pty_err)?;
    let id = allocate_pty_id(manager)?;

    let parsed_agent_kind = context
        .as_ref()
        .and_then(|context| context.agent_type.as_deref())
        .and_then(AgentKind::from_label);
    let initial_prompt_submitted = context
        .as_ref()
        .is_some_and(|context| context.initial_prompt_submitted);
    let activity_key = context
        .and_then(|context| context.agent_id)
        .filter(|key| !key.is_empty());
    let pty = Arc::new(Pty {
        id,
        app: app.clone(),
        #[cfg(unix)]
        io: AsyncFd::new(io_file).map_err(pty_err)?,
        #[cfg(unix)]
        write_lock: tokio::sync::Mutex::new(()),
        #[cfg(windows)]
        master: Mutex::new(pair.master),
        #[cfg(windows)]
        writer: Mutex::new(writer),
        child: Mutex::new(child.into_inner()),
        pid,
        owner,
        parser: Mutex::new(semantic_parser_with_shell(
            rows,
            cols,
            PARSER_SCROLLBACK,
            shell_metadata_enabled,
        )),
        shell_protocol: shell_metadata_enabled,
        subscribers: Mutex::new(HashMap::new()),
        flow_control: tokio::sync::Notify::new(),
        last_activity_ms: AtomicU64::new(now_ms()),
        trimmed: AtomicBool::new(false),
        activity_key,
        agent_kind: parsed_agent_kind,
        activity_armed: AtomicBool::new(initial_prompt_submitted),
        activity_state: AtomicU8::new(ACTIVITY_UNKNOWN),
        report_exit: AtomicBool::new(true),
        last_published_fingerprint: AtomicU64::new(0),
        idle_confirmations: AtomicU8::new(0),
        activity_revision: AtomicU64::new(0),
        last_detection_fingerprint: AtomicU64::new(0),
        last_detection_revision: AtomicU64::new(0),
        task_exit,
        task_exited_at_ms: AtomicU64::new(0),
        harness_output: Mutex::new(crate::harness::OutputLog::default()),
        harness_output_pending: Arc::new(AtomicBool::new(false)),
        _shell_integration: shell_integration,
        _capacity_permit: capacity_permit,
    });

    // Publish before starting the reader. A short-lived command can reach EOF
    // immediately; starting first lets its self-prune remove nothing and then
    // leaves a dead PTY inserted forever.
    manager.ptys.insert(id, pty.clone());
    if pty.agent_kind.is_some() && pty.activity_key.is_some() {
        if initial_prompt_submitted {
            publish_agent_state(
                &pty,
                ACTIVITY_WORKING,
                "working",
                "activity",
                "high",
                "initial prompt submitted",
                None,
            );
        } else {
            publish_agent_state(
                &pty,
                ACTIVITY_IDLE,
                "idle",
                "process",
                "high",
                "agent ready; no prompt submitted",
                None,
            );
        }
    }

    // Reader — feeds parser then fans bytes out to subscribers.
    //
    // Runs as a plain tokio task (no dedicated OS thread). `AsyncFd`
    // parks the task until the kernel signals readability via kqueue
    // (macOS) / epoll (linux), at which point `try_io` does a single
    // non-blocking read. WouldBlock just loops back to `readable().await`
    // after clearing the readiness flag, so we never busy-spin.
    //
    // Atomicity invariant (vs `pty_attach`): a freshly-attached subscriber
    // must see EXACTLY the bytes NOT present in the snapshot it got back.
    // We achieve that by, under the parser lock:
    //   1. processing the chunk into the parser
    //   2. cloning the subscriber list (Tauri Channels are Arc-internal
    //      and cheap to clone)
    // Both locks are then dropped BEFORE the channel sends — so one slow
    // subscriber can't stall the parser or block another PTY's reattach.
    //
    // A Tauri channel send only fails when the webview itself is gone, so
    // the frontend's explicit unsubscribe is what keeps the map small. The
    // per-PTY subscriber cap bounds it either way.
    #[cfg(unix)]
    let pty_reader = pty.clone();
    #[cfg(unix)]
    let app_reader = app.clone();
    #[cfg(unix)]
    tokio::spawn(async move {
        let mut buf = [0u8; OUTPUT_BATCH_BYTES];
        let mut batch = Vec::with_capacity(OUTPUT_BATCH_BYTES);
        'reader: loop {
            // Stop pulling from the child while an attached renderer is too
            // far behind. The kernel PTY buffer fills and the child's own
            // write blocks, which is the backpressure we want.
            if !await_subscriber_credit(&pty_reader.flow_control, || {
                pty_reader
                    .subscribers
                    .lock()
                    .is_ok_and(|subscribers| subscribers_over_budget(&subscribers))
            })
            .await
            {
                forgive_unacked(&pty_reader);
            }
            batch.clear();
            let mut eof = false;
            // The first byte arrives without an artificial delay. Once output
            // starts, collect the tiny writes produced by line-buffered tools
            // for at most 2 ms before one parser pass and one Tauri delivery.
            loop {
                let mut guard = match pty_reader.io.readable().await {
                    Ok(g) => g,
                    Err(_) => break 'reader,
                };
                match guard.try_io(|inner| {
                    let mut f = inner.get_ref();
                    f.read(&mut buf)
                }) {
                    Ok(Ok(0)) => {
                        eof = true;
                        break;
                    }
                    Ok(Ok(n)) => {
                        OUTPUT_READS.fetch_add(1, Ordering::Relaxed);
                        batch.extend_from_slice(&buf[..n]);
                        break;
                    }
                    Ok(Err(_)) => {
                        eof = true;
                        break;
                    }
                    Err(_would_block) => continue,
                }
            }
            if !eof && batch.len() < OUTPUT_BATCH_BYTES {
                let deadline = tokio::time::sleep(OUTPUT_COALESCE);
                tokio::pin!(deadline);
                loop {
                    tokio::select! {
                        _ = &mut deadline => break,
                        ready = pty_reader.io.readable() => {
                            let mut guard = match ready {
                                Ok(g) => g,
                                Err(_) => { eof = true; break; }
                            };
                            match guard.try_io(|inner| {
                                let mut f = inner.get_ref();
                                f.read(&mut buf)
                            }) {
                                Ok(Ok(0)) => { eof = true; break; }
                                Ok(Ok(n)) => {
                                    OUTPUT_READS.fetch_add(1, Ordering::Relaxed);
                                    batch.extend_from_slice(&buf[..n]);
                                    if batch.len() >= OUTPUT_BATCH_BYTES { break; }
                                }
                                Ok(Err(_)) => { eof = true; break; }
                                Err(_would_block) => continue,
                            }
                        }
                    }
                }
            }
            if !batch.is_empty() {
                broadcast_output(&pty_reader, &batch);
            }
            if eof {
                break;
            }
        }
        // Interactive shells self-prune. Completed task PTYs intentionally
        // stay addressable: a zero-duration command can reach EOF before the
        // invoke response crosses into JS, and the frontend must still be able
        // to attach to its bounded parser snapshot by the returned exact ID.
        if pty_reader.task_exit.is_none() {
            if let Some(mgr) = app_reader.try_state::<PtyManager>() {
                mgr.ptys.remove(&id);
            }
        }
        let reap_pty = pty_reader.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let status = if let Ok(mut child) = reap_pty.child.lock() {
                let status = child.wait().ok();
                // Publish while the child lock still proves this pid cannot be
                // concurrently treated as live by app drain.
                let _ = stamp_task_process_exited(&reap_pty);
                status
            } else {
                None
            };
            // Empty payload remains the frontend's "process exited" signal.
            // Waiting first lets the semantic event distinguish a successful
            // completion from a crash/signal instead of always saying unknown.
            notify_process_exited(&reap_pty, status.as_ref());
        });
    });

    #[cfg(windows)]
    {
        let pty_reader = pty.clone();
        let app_reader = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let mut buf = [0u8; 65536];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        OUTPUT_READS.fetch_add(1, Ordering::Relaxed);
                        broadcast_output(&pty_reader, &buf[..n]);
                    }
                    Err(_) => break,
                }
            }
            if pty_reader.task_exit.is_none() {
                if let Some(mgr) = app_reader.try_state::<PtyManager>() {
                    mgr.ptys.remove(&id);
                }
            }
            let status = if let Ok(mut child) = pty_reader.child.lock() {
                let status = child.wait().ok();
                // Keep the completion stamp ordered before a concurrent app
                // drain can acquire the child lock and inspect the stale pid.
                let _ = stamp_task_process_exited(&pty_reader);
                status
            } else {
                None
            };
            notify_process_exited(&pty_reader, status.as_ref());
        });
    }

    Ok(id)
}

#[cfg(test)]
mod tests {
    // The load-bearing invariant of the single-fd PTY design: after we dup
    // the master and drop portable_pty's `MasterPty`, the dup must keep the
    // master open-file-description (and therefore the child's controlling
    // terminal) alive. The child sleeps, THEN prints — so if dropping the
    // MasterPty had hung up the terminal, the child would take SIGHUP during
    // the sleep and the read below would hit EOF before the marker arrives.
    #[cfg(unix)]
    #[test]
    fn lone_master_dup_keeps_child_alive_after_masterpty_drop() {
        use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
        use std::io::Read;
        use std::os::fd::FromRawFd;

        let pair = NativePtySystem::default()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.arg("-c");
        cmd.arg("sleep 0.2; printf MARKER");
        let mut child = pair.slave.spawn_command(cmd).expect("spawn");
        drop(pair.slave);

        let master_fd = pair.master.as_raw_fd().expect("master fd");
        // SAFETY: `pair.master` still owns `master_fd`, so it is open; dup only
        // creates a new fd and touches no memory.
        let dup_fd = unsafe { libc::dup(master_fd) };
        assert!(dup_fd >= 0, "dup failed");
        // The whole point: drop the MasterPty (closes the fd it owned) while
        // our dup still references the same OFD.
        drop(pair.master);

        // SAFETY: `dup_fd` is a fresh fd, checked above, that nothing else owns, so
        // the File is its only owner and closes it exactly once.
        let mut file = unsafe { std::fs::File::from_raw_fd(dup_fd) };
        let mut got = String::new();
        let mut buf = [0u8; 256];
        loop {
            match file.read(&mut buf) {
                Ok(0) => break, // EOF — child gone / pty closed
                Ok(n) => {
                    got.push_str(&String::from_utf8_lossy(&buf[..n]));
                    if got.contains("MARKER") {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = child.wait();
        assert!(
            got.contains("MARKER"),
            "child did not survive MasterPty drop / output never reached the lone dup; got {got:?}"
        );
    }
}

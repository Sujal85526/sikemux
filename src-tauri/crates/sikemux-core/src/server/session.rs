use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use portable_pty::{Child, ExitStatus, NativePtySystem, PtySize, PtySystem};
use sikemux_pty::output_log::OutputLog;
use sikemux_pty::process::SpawnedChildGuard;
use sikemux_pty::screen::{
    attach_snapshot_with_compaction, compact_parser_for_idle, reseed_parser, screen_scrollback_len,
    semantic_parser_with_shell, SemanticParser, IDLE_SCROLLBACK, MAX_ATTACH_SNAPSHOT_BYTES,
    PARSER_SCROLLBACK,
};
use sikemux_pty::shell::ShellLaunchIntegration;
use sikemux_pty::shell_protocol::{PtyShellMetadataEvent, ShellProtocolParser};
use sikemux_pty::task::TaskProcessExit;
use sikemux_pty::validate_pty_dimensions;
use tokio::io::unix::AsyncFd;
use tokio::sync::{mpsc, Notify};

use crate::protocol::{
    encode_output, encode_snapshot, AttachHeader, Event, RequestId, Response, SessionId,
    SessionInfo, SessionKind,
};

use super::agent::{self, AgentActivity};
use super::connection::{ClientConn, ClientId};
use super::prepare::{Owner, PreparedLaunch};
use super::{now_ms, CapacityPermit, Core, CoreError, CoreResult};

const OUTPUT_COALESCE: Duration = Duration::from_millis(2);
const OUTPUT_BATCH_BYTES: usize = 64 * 1024;
/// How many bytes one client may owe before the reader stops pulling from the
/// child. The kernel PTY buffer then applies the backpressure.
pub(crate) const MAX_UNACKED_BYTES: usize = 512 * 1024;
/// A client that owes this long has stopped answering; its debt is written
/// off rather than stalling the child.
pub(crate) const FLOW_CONTROL_WAIT: Duration = Duration::from_secs(1);
pub(crate) const MAX_SUBSCRIBERS_PER_SESSION: usize = 16;
const TASK_OUTPUT_NOTICE_DELAY: Duration = Duration::from_millis(50);

pub(crate) struct Subscriber {
    client: Arc<ClientConn>,
    unacked: AtomicUsize,
}

impl Subscriber {
    fn new(client: Arc<ClientConn>) -> Self {
        Self {
            client,
            unacked: AtomicUsize::new(0),
        }
    }

    fn release(&self, bytes: usize) {
        let _ = self
            .unacked
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |outstanding| {
                Some(outstanding.saturating_sub(bytes))
            });
    }
}

struct InputJob {
    bytes: Vec<u8>,
    reply: Box<dyn FnOnce(std::io::Result<()>) + Send>,
}

pub(crate) struct TaskOutput {
    log: Mutex<OutputLog>,
    notice_pending: AtomicBool,
}

pub(crate) struct Session {
    pub id: SessionId,
    pub kind: SessionKind,
    io: AsyncFd<File>,
    input: mpsc::UnboundedSender<InputJob>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    pid: Option<u32>,
    owner: Owner,
    pub(crate) parser: Mutex<SemanticParser>,
    pub(crate) shell_protocol: bool,
    subscribers: Mutex<HashMap<ClientId, Subscriber>>,
    flow_control: Notify,
    pub(crate) last_activity_ms: AtomicU64,
    pub(crate) trimmed: AtomicBool,
    killed: AtomicBool,
    exit_reported: AtomicBool,
    exited: AtomicBool,
    task: Option<TaskOutput>,
    /// Zero while a task is running; when it was reaped otherwise. Completed
    /// tasks stay attachable for a while.
    pub(crate) task_exited_at_ms: AtomicU64,
    stop_reader: Notify,
    /// Present for a terminal launched for an agent.
    pub(crate) agent: Option<AgentActivity>,
    _shell_integration: Option<ShellLaunchIntegration>,
    _capacity_permit: CapacityPermit,
}

impl Session {
    pub(crate) fn is_task(&self) -> bool {
        self.task.is_some()
    }

    pub(crate) fn is_running(&self) -> bool {
        !self.exited.load(Ordering::Acquire)
    }

    pub(crate) fn has_subscribers(&self) -> Option<bool> {
        self.subscribers.lock().ok().map(|subs| !subs.is_empty())
    }

    pub(crate) fn info(&self) -> SessionInfo {
        let (rows, cols) = self
            .parser
            .lock()
            .map(|parser| parser.screen().size())
            .unwrap_or_default();
        SessionInfo {
            id: self.id,
            kind: self.kind,
            pid: self.pid,
            running: self.is_running(),
            cols,
            rows,
            attached: self.subscribers.lock().map(|subs| subs.len()).unwrap_or(0),
            project: self.owner.project.clone(),
            pane_id: self.owner.pane_id.clone(),
            agent_id: self.owner.agent_id.clone(),
            agent_type: self.owner.agent_type.clone(),
            task_execution_id: self.owner.task_execution_id.clone(),
            agent_state: self
                .agent
                .as_ref()
                .and_then(AgentActivity::state_label)
                .map(str::to_string),
        }
    }
}

fn os_error() -> CoreError {
    CoreError::from(std::io::Error::last_os_error())
}

/// A session that is listed but whose output is not read yet. Starting it
/// after the spawn reply is queued means a client hears about the session
/// before any of its output or its exit.
pub(crate) struct PendingStart {
    session: Arc<Session>,
    input_jobs: mpsc::UnboundedReceiver<InputJob>,
}

impl PendingStart {
    pub(crate) fn id(&self) -> SessionId {
        self.session.id
    }

    pub(crate) fn start(self, core: &Arc<Core>) {
        if let Some(agent) = self.session.agent.as_ref() {
            agent::publish_start(core, agent);
        }
        tokio::spawn(write_input(Arc::downgrade(&self.session), self.input_jobs));
        tokio::spawn(read_output(core.clone(), self.session));
    }
}

/// Opens the terminal and starts its process. Runs on a blocking thread.
pub(crate) fn spawn_session(core: &Arc<Core>, launch: PreparedLaunch) -> CoreResult<PendingStart> {
    validate_pty_dimensions(launch.cols, launch.rows)?;
    core.reclaim_completed_tasks(now_ms());
    let capacity_permit = core.capacity.try_acquire()?;
    let pair = NativePtySystem::default()
        .openpty(PtySize {
            rows: launch.rows,
            cols: launch.cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(CoreError::pty)?;
    let PreparedLaunch {
        cols,
        rows,
        command,
        kind,
        owner,
        shell_integration,
        initial_prompt_submitted,
    } = launch;
    let shell_metadata_enabled = shell_integration.is_some();

    let child = pair.slave.spawn_command(command).map_err(CoreError::pty)?;
    let pid = child.process_id();
    let child = SpawnedChildGuard::new(child);
    drop(pair.slave);

    let master_fd = pair
        .master
        .as_raw_fd()
        .ok_or_else(|| CoreError::from("pty: master pty has no fd"))?;
    // SAFETY: `pair.master` still owns `master_fd`, so the fd is open, and
    // F_GETFL/F_SETFL only read and set its flags without touching memory.
    unsafe {
        let flags = libc::fcntl(master_fd, libc::F_GETFL);
        if flags < 0 {
            return Err(os_error());
        }
        if libc::fcntl(master_fd, libc::F_SETFL, flags | libc::O_NONBLOCK) < 0 {
            return Err(os_error());
        }
    }
    // One fd serves both directions: the dup shares the master's open file
    // description, so dropping portable_pty's master keeps the terminal alive.
    // SAFETY: `pair.master` is dropped only after this line, so `master_fd` is
    // still open; dup creates a new fd and touches no memory.
    let dup_fd = unsafe { libc::dup(master_fd) };
    if dup_fd < 0 {
        return Err(os_error());
    }
    drop(pair.master);
    // SAFETY: `dup_fd` was just created and checked above and nothing else
    // holds it, so the File is its only owner and closes it exactly once.
    let io_file = unsafe { File::from_raw_fd(dup_fd) };
    let io = AsyncFd::new(io_file)?;

    let id = core.next_session_id.fetch_add(1, Ordering::Relaxed);
    let (input, input_jobs) = mpsc::unbounded_channel();
    let agent = AgentActivity::new(
        owner.agent_id.as_deref(),
        owner.agent_type.as_deref(),
        initial_prompt_submitted,
    );
    let session = Arc::new(Session {
        id,
        kind,
        io,
        input,
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
        flow_control: Notify::new(),
        last_activity_ms: AtomicU64::new(now_ms()),
        trimmed: AtomicBool::new(false),
        killed: AtomicBool::new(false),
        exit_reported: AtomicBool::new(false),
        exited: AtomicBool::new(false),
        task: (kind == SessionKind::Task).then(|| TaskOutput {
            log: Mutex::new(OutputLog::default()),
            notice_pending: AtomicBool::new(false),
        }),
        task_exited_at_ms: AtomicU64::new(0),
        stop_reader: Notify::new(),
        agent,
        _shell_integration: shell_integration,
        _capacity_permit: capacity_permit,
    });

    // Publish before starting the reader, so a command that exits at once
    // cannot prune itself before it was ever inserted.
    core.insert_session(session.clone());
    Ok(PendingStart {
        session,
        input_jobs,
    })
}

async fn write_all_async(io: &AsyncFd<File>, mut data: &[u8]) -> std::io::Result<()> {
    while !data.is_empty() {
        let mut guard = io.writable().await?;
        match guard.try_io(|inner| inner.get_ref().write(data)) {
            Ok(Ok(0)) => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::WriteZero,
                    "pty write returned 0",
                ));
            }
            Ok(Ok(n)) => data = data.get(n..).unwrap_or_default(),
            Ok(Err(error)) => return Err(error),
            Err(_would_block) => continue,
        }
    }
    Ok(())
}

/// One writer per session keeps every client's writes in the order they
/// arrived without holding up the connection that sent them.
async fn write_input(session: Weak<Session>, mut jobs: mpsc::UnboundedReceiver<InputJob>) {
    while let Some(job) = jobs.recv().await {
        let result = match session.upgrade() {
            Some(session) => write_all_async(&session.io, &job.bytes).await,
            None => Err(std::io::Error::other("session closed")),
        };
        (job.reply)(result);
    }
}

pub(crate) fn queue_input(
    session: &Session,
    bytes: Vec<u8>,
    reply: Box<dyn FnOnce(std::io::Result<()>) + Send>,
) {
    if let Err(mpsc::error::SendError(job)) = session.input.send(InputJob { bytes, reply }) {
        (job.reply)(Err(std::io::Error::other("session closed")));
    }
}

fn over_budget(session: &Session) -> bool {
    session.subscribers.lock().is_ok_and(|subscribers| {
        subscribers
            .values()
            .any(|subscriber| subscriber.unacked.load(Ordering::Acquire) >= MAX_UNACKED_BYTES)
    })
}

/// Holds the reader while a client is behind. False means the wait ran out.
async fn await_subscriber_credit(session: &Session) -> bool {
    if !over_budget(session) {
        return true;
    }
    loop {
        let notified = session.flow_control.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if !over_budget(session) {
            return true;
        }
        if tokio::time::timeout(FLOW_CONTROL_WAIT, notified)
            .await
            .is_err()
        {
            return false;
        }
    }
}

fn forgive_unacked(session: &Session) {
    if let Ok(subscribers) = session.subscribers.lock() {
        for subscriber in subscribers.values() {
            subscriber.release(usize::MAX);
        }
    }
}

enum ReadOutcome {
    Bytes(usize),
    Eof,
    WouldBlock,
}

fn read_once(
    guard: &mut tokio::io::unix::AsyncFdReadyGuard<'_, File>,
    buf: &mut [u8],
) -> ReadOutcome {
    match guard.try_io(|inner| inner.get_ref().read(buf)) {
        Ok(Ok(0)) | Ok(Err(_)) => ReadOutcome::Eof,
        Ok(Ok(n)) => ReadOutcome::Bytes(n),
        Err(_would_block) => ReadOutcome::WouldBlock,
    }
}

/// Reads until EOF. The first byte goes out at once; after that, small writes
/// are gathered for up to 2 ms into one parser pass and one frame.
async fn pump_output(core: &Arc<Core>, session: &Session) {
    let mut buf = vec![0u8; OUTPUT_BATCH_BYTES];
    let mut batch = Vec::with_capacity(OUTPUT_BATCH_BYTES);
    loop {
        if !await_subscriber_credit(session).await {
            forgive_unacked(session);
        }
        batch.clear();
        let mut eof = false;
        loop {
            let Ok(mut guard) = session.io.readable().await else {
                return;
            };
            match read_once(&mut guard, &mut buf) {
                ReadOutcome::Bytes(n) => {
                    batch.extend_from_slice(buf.get(..n).unwrap_or_default());
                    break;
                }
                ReadOutcome::Eof => {
                    eof = true;
                    break;
                }
                ReadOutcome::WouldBlock => continue,
            }
        }
        if !eof && batch.len() < OUTPUT_BATCH_BYTES {
            let deadline = tokio::time::sleep(OUTPUT_COALESCE);
            tokio::pin!(deadline);
            loop {
                tokio::select! {
                    _ = &mut deadline => break,
                    ready = session.io.readable() => {
                        let Ok(mut guard) = ready else {
                            eof = true;
                            break;
                        };
                        match read_once(&mut guard, &mut buf) {
                            ReadOutcome::Bytes(n) => {
                                batch.extend_from_slice(buf.get(..n).unwrap_or_default());
                                if batch.len() >= OUTPUT_BATCH_BYTES {
                                    break;
                                }
                            }
                            ReadOutcome::Eof => {
                                eof = true;
                                break;
                            }
                            ReadOutcome::WouldBlock => continue,
                        }
                    }
                }
            }
        }
        if !batch.is_empty() {
            broadcast_output(core, session, &batch);
        }
        if eof {
            return;
        }
    }
}

async fn read_output(core: Arc<Core>, session: Arc<Session>) {
    let stopped = tokio::select! {
        _ = pump_output(&core, &session) => false,
        _ = session.stop_reader.notified() => true,
    };
    if stopped {
        return;
    }
    // Terminals leave when their output ends. Completed tasks stay, so a
    // command that finished before its spawn reply arrived can still be read.
    if !session.is_task() {
        core.remove_session(&session);
    }
    let _ = tokio::task::spawn_blocking(move || {
        let status = match session.child.lock() {
            Ok(mut child) => {
                let status = child.wait().ok();
                // Stamped under the child lock, so a concurrent kill or drain
                // never signals a pid that may already be reused.
                stamp_task_exited(&session);
                status
            }
            Err(_) => None,
        };
        report_exit(&core, &session, status.as_ref());
    })
    .await;
}

pub(crate) fn stamp_task_exited(session: &Session) -> Option<u64> {
    session.task.as_ref()?;
    let exited_at = now_ms().max(1);
    match session.task_exited_at_ms.compare_exchange(
        0,
        exited_at,
        Ordering::AcqRel,
        Ordering::Acquire,
    ) {
        Ok(_) => {
            session.last_activity_ms.store(exited_at, Ordering::Release);
            Some(exited_at)
        }
        Err(existing) => Some(existing),
    }
}

/// Tells every client the process is gone. Natural exit, kill and shutdown can
/// race here; only the first one is reported.
pub(crate) fn report_exit(core: &Core, session: &Session, status: Option<&ExitStatus>) {
    let exited_at = stamp_task_exited(session);
    session.exited.store(true, Ordering::Release);
    if session.exit_reported.swap(true, Ordering::AcqRel) {
        return;
    }
    let (code, signal) = match status {
        Some(status) => {
            let exit = TaskProcessExit::from_status(Some(status));
            (Some(exit.code), exit.signal)
        }
        None => (None, None),
    };
    core.broadcast_event(&Event::Exited {
        id: session.id,
        code,
        signal,
        killed: session.killed.load(Ordering::Acquire),
    });
    if let Some(agent) = session.agent.as_ref() {
        agent::note_exit(core, agent, status);
    }
    if let Some(exited_at) = exited_at {
        core.reclaim_completed_tasks(exited_at);
    }
}

fn broadcast_output(core: &Arc<Core>, session: &Session, bytes: &[u8]) {
    if let Some(task) = session.task.as_ref() {
        if let Ok(mut log) = task.log.lock() {
            log.push(bytes);
        }
        if !task.notice_pending.swap(true, Ordering::AcqRel) {
            core.schedule_task_output_notice(session.id, TASK_OUTPUT_NOTICE_DELAY);
        }
    }
    let output_now_ms = now_ms();
    session
        .last_activity_ms
        .store(output_now_ms, Ordering::Relaxed);
    if let Some(agent) = session.agent.as_ref() {
        agent::note_output(core, agent);
    }
    let Ok(mut parser) = session.parser.lock() else {
        return;
    };
    if session.trimmed.swap(false, Ordering::AcqRel) {
        reseed_parser(&mut parser, PARSER_SCROLLBACK);
    }
    let shell_output = parser
        .callbacks_mut()
        .shell
        .as_mut()
        .map(|shell| shell.process_for_events(bytes, output_now_ms))
        .unwrap_or_default();
    parser.process(bytes);
    if let Some(agent) = session.agent.as_ref() {
        agent.note_parsed();
    }
    // Frames are queued under the parser lock, the same lock an attach holds
    // while it takes its snapshot, so a client sees every byte exactly once.
    send_to_subscribers(session, bytes);
    drop(parser);
    if let Some(update) = shell_output.ready {
        core.broadcast_event(&Event::ShellMetadata(PtyShellMetadataEvent::from_update(
            session.id, update,
        )));
    }
}

/// Callers hold the parser lock, which keeps frames in the order the parser
/// saw the bytes.
fn send_to_subscribers(session: &Session, bytes: &[u8]) {
    if let Ok(mut subscribers) = session.subscribers.lock() {
        if !subscribers.is_empty() {
            let frame: Arc<[u8]> = encode_output(session.id, bytes).into();
            subscribers.retain(|_, subscriber| {
                let sent = subscriber.client.send(frame.clone());
                if sent {
                    subscriber.unacked.fetch_add(bytes.len(), Ordering::AcqRel);
                }
                sent
            });
        }
    }
}

pub(crate) const RESET_MODES: &[u8] = b"\x1b>\x1b[4l\x1b[?1l\x1b[?6l\x1b[?7h\x1b[?9l\x1b[?45l\x1b[?66l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1004l\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?1016l\x1b[?2004l\x1b[?1049l";

/// Sends the same reset to the screen and every subscriber under the parser
/// lock, so no output from the program can land between the two.
pub(crate) fn reset_modes(session: &Session) -> CoreResult<()> {
    let mut parser = session.parser.lock().map_err(CoreError::poisoned)?;
    parser.process(RESET_MODES);
    send_to_subscribers(session, RESET_MODES);
    Ok(())
}

pub(crate) fn mark_task_output_noticed(session: &Session) {
    if let Some(task) = session.task.as_ref() {
        task.notice_pending.store(false, Ordering::Release);
    }
}

/// Takes the snapshot and subscribes in one step under the parser lock, then
/// queues the snapshot frame before any later output can be queued.
pub(crate) fn attach(
    session: &Session,
    client: &Arc<ClientConn>,
    request_id: RequestId,
) -> CoreResult<()> {
    let mut parser = session.parser.lock().map_err(CoreError::poisoned)?;
    let alternate_screen = parser.screen().alternate_screen();
    let mut subscribers = session.subscribers.lock().map_err(CoreError::poisoned)?;
    if !subscribers.contains_key(&client.id) && subscribers.len() >= MAX_SUBSCRIBERS_PER_SESSION {
        return Err("pty: PTY subscriber capacity reached".into());
    }
    let replay = attach_snapshot_with_compaction(&mut parser, MAX_ATTACH_SNAPSHOT_BYTES)?;
    let shell = parser
        .callbacks()
        .shell
        .as_ref()
        .map(ShellProtocolParser::snapshot);
    let frame = encode_snapshot(
        request_id,
        session.id,
        &AttachHeader {
            alternate_screen,
            shell,
        },
        &replay,
    )?;
    if !client.send(frame.into()) {
        return Err("client disconnected".into());
    }
    subscribers.insert(client.id, Subscriber::new(client.clone()));
    client.note_subscription(session.id, true);
    drop(subscribers);
    drop(parser);
    session.flow_control.notify_waiters();
    Ok(())
}

/// Subscribes without a replay. The reply is queued under the parser lock,
/// so the client knows exactly which output frames come after it.
pub(crate) fn subscribe(
    session: &Session,
    client: &Arc<ClientConn>,
    request_id: RequestId,
) -> CoreResult<()> {
    let parser = session.parser.lock().map_err(CoreError::poisoned)?;
    let mut subscribers = session.subscribers.lock().map_err(CoreError::poisoned)?;
    if !subscribers.contains_key(&client.id) && subscribers.len() >= MAX_SUBSCRIBERS_PER_SESSION {
        return Err("pty: PTY subscriber capacity reached".into());
    }
    client.respond(request_id, Ok(Response::Done));
    subscribers.insert(client.id, Subscriber::new(client.clone()));
    client.note_subscription(session.id, true);
    drop(subscribers);
    drop(parser);
    session.flow_control.notify_waiters();
    Ok(())
}

pub(crate) fn detach(session: &Session, client: ClientId) {
    let emptied = match session.subscribers.lock() {
        Ok(mut subscribers) => {
            if subscribers.remove(&client).is_none() {
                return;
            }
            subscribers.is_empty()
        }
        Err(_) => return,
    };
    session.flow_control.notify_waiters();
    if !emptied || session.trimmed.load(Ordering::Acquire) {
        return;
    }
    // Nobody is looking any more, so keep only what a reattach replays.
    // Re-check under the parser lock so an attach that raced us keeps its
    // history.
    let Ok(mut parser) = session.parser.lock() else {
        return;
    };
    if !session
        .subscribers
        .lock()
        .is_ok_and(|subscribers| subscribers.is_empty())
    {
        return;
    }
    if screen_scrollback_len(parser.screen_mut()) <= IDLE_SCROLLBACK {
        return;
    }
    if compact_parser_for_idle(&mut parser) {
        session.trimmed.store(true, Ordering::Release);
    }
}

pub(crate) fn detach_all(session: &Session) {
    let subscribers = match session.subscribers.lock() {
        Ok(mut subscribers) => std::mem::take(&mut *subscribers),
        Err(_) => return,
    };
    for subscriber in subscribers.values() {
        subscriber.client.note_subscription(session.id, false);
    }
}

pub(crate) fn ack(session: &Session, client: ClientId, bytes: usize) {
    if let Ok(subscribers) = session.subscribers.lock() {
        let Some(subscriber) = subscribers.get(&client) else {
            return;
        };
        subscriber.release(bytes);
    }
    session.flow_control.notify_waiters();
}

pub(crate) fn resize(session: &Session, cols: u16, rows: u16) -> CoreResult<()> {
    let size = libc::winsize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    // SAFETY: the fd belongs to `session.io`, which stays open for this call,
    // and `size` is a live winsize on the stack, the struct TIOCSWINSZ reads.
    let rc = unsafe {
        libc::ioctl(
            session.io.get_ref().as_raw_fd(),
            libc::TIOCSWINSZ,
            &size as *const libc::winsize,
        )
    };
    if rc != 0 {
        return Err(os_error());
    }
    if let Ok(mut parser) = session.parser.lock() {
        parser.screen_mut().set_size(rows, cols);
    }
    Ok(())
}

pub(crate) fn task_output(
    session: &Session,
    query: &sikemux_pty::output_log::OutputQuery,
) -> CoreResult<sikemux_pty::output_log::OutputPage> {
    let task = session
        .task
        .as_ref()
        .ok_or_else(|| CoreError::from("PTY is not a managed task"))?;
    task.log
        .lock()
        .map_err(|_| CoreError::from("output lock poisoned"))?
        .query(query)
        .map_err(CoreError::from)
}

pub(crate) fn kill(core: &Core, session: &Session) {
    session.killed.store(true, Ordering::Release);
    if let Some(agent) = session.agent.as_ref() {
        agent.silence();
    }
    let status = match session.child.lock() {
        Ok(mut child) => {
            let force_task_tree = sikemux_pty::task::task_process_needs_force_backstop(
                session.is_task(),
                session.task_exited_at_ms.load(Ordering::Acquire),
            );
            let status =
                sikemux_pty::process::terminate_and_reap_child(&mut child, force_task_tree);
            stamp_task_exited(session);
            status
        }
        Err(_) => None,
    };
    report_exit(core, session, status.as_ref());
    if !session.is_task() {
        // The shell is gone. Anything still holding the terminal open would
        // keep the reader, and with it the PTY, alive for good.
        session.stop_reader.notify_one();
    }
}

/// First half of shutting everything down: ask the process tree to stop.
pub(crate) fn signal_for_drain(session: &Session) {
    session.killed.store(true, Ordering::Release);
    if let Ok(child) = session.child.lock() {
        if sikemux_pty::task::should_signal_process_on_drain(
            session.is_task(),
            session.task_exited_at_ms.load(Ordering::Acquire),
        ) {
            if let Some(pid) = child.process_id() {
                sikemux_pty::process::terminate_process_tree(pid, false);
            }
        }
    }
}

/// Second half, after the shared grace: force whatever is left and reap it.
pub(crate) fn finish_drain(core: &Core, session: &Session) {
    use sikemux_pty::process::{child_process_id, kill_and_reap_child, terminate_process_tree};
    use sikemux_pty::task::{should_signal_process_on_drain, task_process_needs_force_backstop};
    let status = match session.child.lock() {
        Ok(mut child) => {
            let is_task = session.is_task();
            let exited_at = session.task_exited_at_ms.load(Ordering::Acquire);
            let status = if !should_signal_process_on_drain(is_task, exited_at) {
                child.try_wait().ok().flatten()
            } else if task_process_needs_force_backstop(is_task, exited_at) {
                let pid = child_process_id(&mut child);
                if let Some(pid) = pid {
                    terminate_process_tree(pid, true);
                }
                match child.try_wait() {
                    Ok(Some(status)) => Some(status),
                    _ => kill_and_reap_child(&mut child, pid),
                }
            } else if let Ok(Some(status)) = child.try_wait() {
                Some(status)
            } else {
                let pid = child_process_id(&mut child);
                kill_and_reap_child(&mut child, pid)
            };
            stamp_task_exited(session);
            status
        }
        Err(_) => None,
    };
    report_exit(core, session, status.as_ref());
    session.stop_reader.notify_one();
}

pub(crate) fn trim_if_idle(session: &Session, now: u64, idle: Duration) {
    let idle_ms = idle.as_millis() as u64;
    let quiet = || now.saturating_sub(session.last_activity_ms.load(Ordering::Relaxed)) >= idle_ms;
    if session.trimmed.load(Ordering::Relaxed)
        || !quiet()
        || session.has_subscribers() != Some(false)
    {
        return;
    }
    let Ok(mut parser) = session.parser.lock() else {
        return;
    };
    // Output and attaches take the parser lock first, so re-checking under it
    // means neither can slip in between the check and the compaction.
    if !quiet() || session.has_subscribers() != Some(false) {
        return;
    }
    if compact_parser_for_idle(&mut parser) {
        session.trimmed.store(true, Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::RESET_MODES;
    use sikemux_pty::screen::{semantic_parser_with_shell, PARSER_SCROLLBACK};

    // The single-fd design rests on this: after the master is dup'd and
    // portable_pty's `MasterPty` dropped, the dup keeps the child's terminal
    // open. The child sleeps before printing, so a hangup on drop would end
    // the read before the marker arrives.
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
        drop(pair.master);

        // SAFETY: `dup_fd` is a fresh fd, checked above, that nothing else owns,
        // so the File is its only owner and closes it exactly once.
        let mut file = unsafe { std::fs::File::from_raw_fd(dup_fd) };
        let mut got = String::new();
        let mut buf = [0u8; 256];
        loop {
            match file.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    got.push_str(&String::from_utf8_lossy(&buf[..n]));
                    if got.contains("MARKER") {
                        break;
                    }
                }
            }
        }
        let _ = child.wait();
        assert!(
            got.contains("MARKER"),
            "the child lost its terminal; got {got:?}"
        );
    }

    #[test]
    fn reset_modes_disables_interaction_modes_without_losing_normal_history() {
        let mut parser = semantic_parser_with_shell(5, 20, PARSER_SCROLLBACK, false);
        for i in 0..20 {
            parser.process(format!("line {i:02}\r\n").as_bytes());
        }
        parser.process(
            b"\x1b=\x1b[?1h\x1b[?9h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1005h\x1b[?1006h\x1b[?2004h\x1b[?1049halt",
        );
        parser.process(RESET_MODES);

        assert!(!parser.screen().alternate_screen());
        assert!(!parser.screen().application_keypad());
        assert!(!parser.screen().application_cursor());
        assert!(!parser.screen().bracketed_paste());
        assert_eq!(
            parser.screen().mouse_protocol_mode(),
            vt100::MouseProtocolMode::None
        );
        assert_eq!(
            parser.screen().mouse_protocol_encoding(),
            vt100::MouseProtocolEncoding::Default
        );
        let screen = parser.screen_mut();
        screen.set_scrollback(usize::MAX);
        assert!(screen.contents().contains("line 00"));
    }
}

mod connection;
mod prepare;
mod session;

use std::collections::HashMap;
use std::fs::{DirBuilder, File, OpenOptions};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use sikemux_pty::error::PtyError;
use sikemux_pty::process::DRAIN_GRACE;
use sikemux_pty::task::{
    task_reclamation_plan, TaskRetentionCandidate, MAX_RETAINED_EXITED_TASK_PTYS,
};
use tokio::sync::watch;

use crate::client::{probe, ProbeError};
use crate::protocol::{encode_control, Event, ServerMessage, SessionId};

use connection::{ClientConn, ClientId};
use session::Session;

pub const DEFAULT_IDLE_EXIT: Duration = Duration::from_secs(5 * 60);
const MAX_ACTIVE_SESSIONS: usize = 256;
const SHELL_METADATA_POLL: Duration = Duration::from_millis(250);
const SWEEP_INTERVAL: Duration = Duration::from_secs(60);
const IDLE_TRIM: Duration = Duration::from_secs(10 * 60);
const PROBE_TIMEOUT: Duration = Duration::from_secs(1);

#[derive(Clone, Debug)]
pub struct ServerConfig {
    pub socket: PathBuf,
    pub idle_exit: Duration,
}

impl ServerConfig {
    pub fn new(socket: PathBuf) -> Self {
        Self {
            socket,
            idle_exit: DEFAULT_IDLE_EXIT,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ServerError {
    #[error("a Sikemux core is already running at {}{}", path.display(), pid.map(|pid| format!(" (pid {pid})")).unwrap_or_default())]
    AlreadyRunning { path: PathBuf, pid: Option<u32> },
    #[error("{} is in use by a process that is not a Sikemux core", .0.display())]
    SocketInUse(PathBuf),
    #[error("{0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug)]
pub(crate) struct CoreError(String);

impl std::fmt::Display for CoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl CoreError {
    fn pty(error: impl std::fmt::Display) -> Self {
        Self(format!("pty: {error}"))
    }

    fn poisoned<T>(_: T) -> Self {
        Self("pty: lock poisoned".into())
    }
}

impl From<&str> for CoreError {
    fn from(message: &str) -> Self {
        Self(message.into())
    }
}

impl From<String> for CoreError {
    fn from(message: String) -> Self {
        Self(message)
    }
}

impl From<PtyError> for CoreError {
    fn from(error: PtyError) -> Self {
        Self(error.to_string())
    }
}

impl From<std::io::Error> for CoreError {
    fn from(error: std::io::Error) -> Self {
        Self(format!("io: {error}"))
    }
}

impl From<serde_json::Error> for CoreError {
    fn from(error: serde_json::Error) -> Self {
        Self(format!("json: {error}"))
    }
}

pub(crate) type CoreResult<T> = Result<T, CoreError>;

fn epoch() -> Instant {
    static EPOCH: OnceLock<Instant> = OnceLock::new();
    *EPOCH.get_or_init(Instant::now)
}

pub(crate) fn now_ms() -> u64 {
    epoch().elapsed().as_millis() as u64
}

/// Counts launching, live and retained sessions, so the PTY budget holds even
/// while a session is between being spawned and being published.
pub(crate) struct Capacity {
    active: AtomicUsize,
    limit: usize,
}

pub(crate) struct CapacityPermit(Arc<Capacity>);

impl Capacity {
    fn try_acquire(self: &Arc<Self>) -> CoreResult<CapacityPermit> {
        self.active
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |active| {
                (active < self.limit).then_some(active + 1)
            })
            .map(|_| CapacityPermit(self.clone()))
            .map_err(|_| CoreError::from("pty: PTY capacity reached"))
    }
}

impl Drop for CapacityPermit {
    fn drop(&mut self) {
        self.0.active.fetch_sub(1, Ordering::AcqRel);
    }
}

pub(crate) struct Core {
    sessions: Mutex<HashMap<SessionId, Arc<Session>>>,
    next_session_id: AtomicU64,
    capacity: Arc<Capacity>,
    clients: Mutex<HashMap<ClientId, Arc<ClientConn>>>,
    next_client_id: AtomicU64,
    shutdown: watch::Sender<bool>,
}

impl Core {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            sessions: Mutex::new(HashMap::new()),
            next_session_id: AtomicU64::new(1),
            capacity: Arc::new(Capacity {
                active: AtomicUsize::new(0),
                limit: MAX_ACTIVE_SESSIONS,
            }),
            clients: Mutex::new(HashMap::new()),
            next_client_id: AtomicU64::new(1),
            shutdown: watch::channel(false).0,
        })
    }

    pub(crate) fn session(&self, id: SessionId) -> Option<Arc<Session>> {
        self.sessions.lock().ok()?.get(&id).cloned()
    }

    fn all_sessions(&self) -> Vec<Arc<Session>> {
        self.sessions
            .lock()
            .map(|sessions| sessions.values().cloned().collect())
            .unwrap_or_default()
    }

    fn insert_session(&self, session: Arc<Session>) {
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.insert(session.id, session);
        }
    }

    pub(crate) fn remove_session(&self, session: &Arc<Session>) -> bool {
        let removed = self.sessions.lock().is_ok_and(|mut sessions| {
            if sessions
                .get(&session.id)
                .is_some_and(|current| Arc::ptr_eq(current, session))
            {
                sessions.remove(&session.id);
                true
            } else {
                false
            }
        });
        if removed {
            session::detach_all(session);
        }
        removed
    }

    fn take_session_for_kill(&self, id: SessionId) -> Option<Arc<Session>> {
        let mut sessions = self.sessions.lock().ok()?;
        let session = sessions.get(&id)?.clone();
        // A killed task keeps its snapshot and output log for later reads.
        if !session.is_task() {
            sessions.remove(&id);
            drop(sessions);
            session::detach_all(&session);
        }
        Some(session)
    }

    fn running_sessions(&self) -> usize {
        self.sessions
            .lock()
            .map(|sessions| sessions.values().filter(|s| s.is_running()).count())
            .unwrap_or(0)
    }

    fn is_idle(&self) -> bool {
        self.clients.lock().is_ok_and(|clients| clients.is_empty()) && self.running_sessions() == 0
    }

    fn register_client(&self, client: Arc<ClientConn>) {
        if let Ok(mut clients) = self.clients.lock() {
            clients.insert(client.id, client);
        }
    }

    fn unregister_client(&self, client: &ClientConn) {
        client.close();
        if let Ok(mut clients) = self.clients.lock() {
            clients.remove(&client.id);
        }
        for id in client.take_subscriptions() {
            if let Some(session) = self.session(id) {
                session::detach(&session, client.id);
            }
        }
    }

    pub(crate) fn broadcast_event(&self, event: &Event) {
        let Ok(frame) = encode_control(&ServerMessage::Event {
            event: event.clone(),
        }) else {
            return;
        };
        let frame: Arc<[u8]> = frame.into();
        let clients: Vec<Arc<ClientConn>> = self
            .clients
            .lock()
            .map(|clients| clients.values().cloned().collect())
            .unwrap_or_default();
        for client in clients {
            client.send(frame.clone());
        }
    }

    pub(crate) fn schedule_task_output_notice(self: &Arc<Self>, id: SessionId, delay: Duration) {
        let core = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            if let Some(session) = core.session(id) {
                session::mark_task_output_noticed(&session);
            }
            core.broadcast_event(&Event::TaskOutput { id });
        });
    }

    pub(crate) fn reclaim_completed_tasks(&self, now: u64) {
        let tasks: Vec<Arc<Session>> = self
            .all_sessions()
            .into_iter()
            .filter(|session| session.is_task())
            .collect();
        let candidates = tasks
            .iter()
            .enumerate()
            .filter_map(|(index, session)| {
                Some(TaskRetentionCandidate {
                    id: index as u32,
                    exited_at_ms: session.task_exited_at_ms.load(Ordering::Acquire),
                    has_subscribers: session.has_subscribers()?,
                })
            })
            .collect();
        for index in task_reclamation_plan(candidates, now, MAX_RETAINED_EXITED_TASK_PTYS) {
            let Some(session) = tasks.get(index as usize) else {
                continue;
            };
            if session.task_exited_at_ms.load(Ordering::Acquire) != 0
                && session.has_subscribers() == Some(false)
            {
                self.remove_session(session);
            }
        }
    }

    fn drain(&self) {
        let sessions: Vec<Arc<Session>> = match self.sessions.lock() {
            Ok(mut sessions) => sessions.drain().map(|(_, session)| session).collect(),
            Err(_) => return,
        };
        if sessions.is_empty() {
            return;
        }
        for session in &sessions {
            session::signal_for_drain(session);
        }
        std::thread::sleep(DRAIN_GRACE);
        for session in &sessions {
            session::finish_drain(self, session);
            session::detach_all(session);
        }
    }

    fn begin_shutdown(&self) {
        self.shutdown.send_replace(true);
    }
}

fn lock_path(socket: &Path) -> PathBuf {
    let mut path = socket.as_os_str().to_owned();
    path.push(".lock");
    PathBuf::from(path)
}

/// Takes the single-instance lock and binds the socket. The lock is held for
/// the life of the core and released by the kernel when it exits.
fn claim_socket(socket: &Path) -> Result<(std::os::unix::net::UnixListener, File), ServerError> {
    if let Some(parent) = socket
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        if !parent.exists() {
            DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(parent)?;
        }
    }
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(lock_path(socket))?;
    // SAFETY: flock only reads the integer fd, which `lock` keeps open.
    if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err(ServerError::AlreadyRunning {
            path: socket.to_path_buf(),
            pid: probe(socket, PROBE_TIMEOUT).ok().map(|hello| hello.pid),
        });
    }
    match probe(socket, PROBE_TIMEOUT) {
        Ok(hello) => {
            return Err(ServerError::AlreadyRunning {
                path: socket.to_path_buf(),
                pid: Some(hello.pid),
            })
        }
        Err(ProbeError::Rejected { pid, .. }) => {
            return Err(ServerError::AlreadyRunning {
                path: socket.to_path_buf(),
                pid: Some(pid),
            })
        }
        Err(ProbeError::Unanswered(_)) => {
            return Err(ServerError::SocketInUse(socket.to_path_buf()))
        }
        Err(ProbeError::NotRunning(_)) => {}
    }
    match std::fs::remove_file(socket) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let listener = std::os::unix::net::UnixListener::bind(socket)?;
    std::fs::set_permissions(socket, std::fs::Permissions::from_mode(0o600))?;
    Ok((listener, lock))
}

async fn flush_shell_metadata(core: Arc<Core>) {
    let mut ticker = tokio::time::interval(SHELL_METADATA_POLL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        ticker.tick().await;
        let now = now_ms();
        for session in core.all_sessions() {
            if !session.shell_protocol {
                continue;
            }
            let update = session.parser.lock().ok().and_then(|mut parser| {
                parser
                    .callbacks_mut()
                    .shell
                    .as_mut()
                    .and_then(|shell| shell.take_due_event(now))
            });
            if let Some(update) = update {
                core.broadcast_event(&Event::ShellMetadata(
                    sikemux_pty::shell_protocol::PtyShellMetadataEvent::from_update(
                        session.id, update,
                    ),
                ));
            }
        }
    }
}

async fn sweep(core: Arc<Core>) {
    let mut ticker = tokio::time::interval(SWEEP_INTERVAL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    ticker.tick().await;
    loop {
        ticker.tick().await;
        let now = now_ms();
        core.reclaim_completed_tasks(now);
        for session in core.all_sessions() {
            session::trim_if_idle(&session, now, IDLE_TRIM);
        }
    }
}

/// Serves until a client asks it to shut down or the core has been idle for
/// `idle_exit`.
pub async fn serve(config: ServerConfig) -> Result<(), ServerError> {
    let socket = config.socket.clone();
    let (listener, lock) = tokio::task::spawn_blocking(move || claim_socket(&socket))
        .await
        .map_err(std::io::Error::other)??;
    listener.set_nonblocking(true)?;
    let listener = tokio::net::UnixListener::from_std(listener)?;
    let core = Core::new();
    let background = [
        tokio::spawn(flush_shell_metadata(core.clone())),
        tokio::spawn(sweep(core.clone())),
    ];
    let mut shutdown = core.shutdown.subscribe();
    let mut ticker = tokio::time::interval(
        (config.idle_exit / 10).clamp(Duration::from_millis(10), Duration::from_secs(1)),
    );
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut idle_since: Option<Instant> = None;
    loop {
        tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok((stream, _)) => {
                    tokio::spawn(connection::serve_client(core.clone(), stream));
                }
                Err(error) => {
                    eprintln!("sikemux core: accept failed: {error}");
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
            },
            _ = shutdown.changed() => break,
            _ = ticker.tick() => {
                if core.is_idle() {
                    let since = *idle_since.get_or_insert_with(Instant::now);
                    if since.elapsed() >= config.idle_exit {
                        break;
                    }
                } else {
                    idle_since = None;
                }
            }
        }
    }
    for task in background {
        task.abort();
    }
    drop(listener);
    let _ = std::fs::remove_file(&config.socket);
    drop(lock);
    Ok(())
}

pub fn run(config: ServerConfig) -> Result<(), ServerError> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .thread_name("sikemux-core")
        .build()?;
    let result = runtime.block_on(serve(config));
    runtime.shutdown_timeout(Duration::from_millis(100));
    result
}

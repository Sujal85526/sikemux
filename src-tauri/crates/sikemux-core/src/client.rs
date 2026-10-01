use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::{self, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::net::UnixStream as StdUnixStream;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use sikemux_pty::output_log::{OutputPage, OutputQuery};
use sikemux_pty::shell_protocol::ShellMetadataSnapshot;
use tokio::io::{AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

use crate::protocol::{
    decode_output, decode_snapshot, encode_control, encode_input, read_frame, read_frame_sync,
    AttachHeader, ClientMessage, Event, FrameKind, LaunchIdentity, Request, RequestId, Response,
    ServerMessage, SessionId, SessionInfo, SpawnTarget, PROTOCOL, PROTOCOL_VERSION,
};

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
const PROBE_TIMEOUT: Duration = Duration::from_secs(1);
const START_TIMEOUT: Duration = Duration::from_secs(5);
const START_POLL: Duration = Duration::from_millis(20);

#[derive(Debug, thiserror::Error)]
pub enum ClientError {
    #[error("could not reach the Sikemux core: {0}")]
    Io(#[from] io::Error),
    #[error("{message}")]
    VersionMismatch {
        version: u32,
        pid: u32,
        message: String,
    },
    #[error("the Sikemux core did not finish the handshake: {0}")]
    Handshake(String),
    #[error("{0}")]
    Core(String),
    #[error("the connection to the Sikemux core closed")]
    Disconnected,
    #[error("the Sikemux core sent a reply of the wrong kind")]
    UnexpectedReply,
    #[error("could not encode a message for the Sikemux core: {0}")]
    Encode(#[from] serde_json::Error),
    #[error("the Sikemux core did not start within {0:?}")]
    StartTimeout(Duration),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CoreHello {
    pub pid: u32,
    pub version: u32,
}

#[derive(Debug)]
pub enum ClientEvent {
    Output { id: SessionId, bytes: Vec<u8> },
    Event(Event),
}

/// The replay of an attach. Live output for the session follows it on the
/// event stream, starting with the first byte the replay does not contain.
#[derive(Clone, Debug)]
pub struct Attached {
    pub alternate_screen: bool,
    pub shell: Option<ShellMetadataSnapshot>,
    pub replay: Vec<u8>,
}

enum Reply {
    Response(Response),
    Error(String),
    Snapshot(AttachHeader, Vec<u8>),
}

type Pending = Arc<Mutex<Option<HashMap<RequestId, oneshot::Sender<Reply>>>>>;

/// One connection to the core. Dropping it disconnects; sessions keep running.
/// Reconnecting is the caller's job.
pub struct CoreClient {
    outgoing: mpsc::UnboundedSender<Vec<u8>>,
    pending: Pending,
    next_request: AtomicU64,
    hello: CoreHello,
    tasks: [JoinHandle<()>; 2],
}

impl Drop for CoreClient {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
    }
}

fn hello_reply(message: ServerMessage) -> Result<CoreHello, ClientError> {
    match message {
        ServerMessage::HelloAck {
            protocol,
            version,
            pid,
        } if protocol == PROTOCOL => Ok(CoreHello { pid, version }),
        ServerMessage::HelloRejected {
            version,
            pid,
            message,
            ..
        } => Err(ClientError::VersionMismatch {
            version,
            pid,
            message,
        }),
        ServerMessage::Error { message, .. } => Err(ClientError::Handshake(message)),
        _ => Err(ClientError::Handshake("unexpected reply to hello".into())),
    }
}

fn hello_frame() -> Result<Vec<u8>, ClientError> {
    Ok(encode_control(&ClientMessage::Hello {
        protocol: PROTOCOL.into(),
        version: PROTOCOL_VERSION,
    })?)
}

impl CoreClient {
    pub async fn connect(
        socket: &Path,
    ) -> Result<(Self, mpsc::UnboundedReceiver<ClientEvent>), ClientError> {
        let stream = UnixStream::connect(socket).await?;
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        write_half.write_all(&hello_frame()?).await?;
        let frame = tokio::time::timeout(HANDSHAKE_TIMEOUT, read_frame(&mut reader))
            .await
            .map_err(|_| ClientError::Handshake("timed out".into()))??
            .ok_or_else(|| ClientError::Handshake("the core closed the connection".into()))?;
        if frame.kind != FrameKind::Control {
            return Err(ClientError::Handshake("unexpected frame".into()));
        }
        let hello = hello_reply(serde_json::from_slice(&frame.payload)?)?;

        let pending: Pending = Arc::new(Mutex::new(Some(HashMap::new())));
        let (events, event_queue) = mpsc::unbounded_channel();
        let (outgoing, mut outgoing_queue) = mpsc::unbounded_channel::<Vec<u8>>();
        let writer = tokio::spawn(async move {
            while let Some(frame) = outgoing_queue.recv().await {
                if write_half.write_all(&frame).await.is_err() {
                    return;
                }
            }
        });
        let reader_pending = pending.clone();
        let reader = tokio::spawn(async move {
            while let Ok(Some(frame)) = read_frame(&mut reader).await {
                dispatch(frame, &reader_pending, &events);
            }
            if let Ok(mut pending) = reader_pending.lock() {
                pending.take();
            }
        });
        Ok((
            Self {
                outgoing,
                pending,
                next_request: AtomicU64::new(1),
                hello,
                tasks: [reader, writer],
            },
            event_queue,
        ))
    }

    pub fn core_pid(&self) -> u32 {
        self.hello.pid
    }

    fn register(&self) -> Result<(RequestId, oneshot::Receiver<Reply>), ClientError> {
        let request_id = self.next_request.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        let mut pending = self.pending.lock().map_err(|_| ClientError::Disconnected)?;
        pending
            .as_mut()
            .ok_or(ClientError::Disconnected)?
            .insert(request_id, sender);
        Ok((request_id, receiver))
    }

    async fn exchange(
        &self,
        request_id: RequestId,
        receiver: oneshot::Receiver<Reply>,
        frame: Vec<u8>,
    ) -> Result<Reply, ClientError> {
        if self.outgoing.send(frame).is_err() {
            if let Ok(mut pending) = self.pending.lock() {
                if let Some(pending) = pending.as_mut() {
                    pending.remove(&request_id);
                }
            }
            return Err(ClientError::Disconnected);
        }
        match receiver.await.map_err(|_| ClientError::Disconnected)? {
            Reply::Error(message) => Err(ClientError::Core(message)),
            reply => Ok(reply),
        }
    }

    async fn request(&self, request: Request) -> Result<Response, ClientError> {
        let (request_id, receiver) = self.register()?;
        let frame = encode_control(&ClientMessage::Request {
            request_id,
            request,
        })?;
        match self.exchange(request_id, receiver, frame).await? {
            Reply::Response(response) => Ok(response),
            _ => Err(ClientError::UnexpectedReply),
        }
    }

    async fn request_done(&self, request: Request) -> Result<(), ClientError> {
        match self.request(request).await? {
            Response::Done => Ok(()),
            _ => Err(ClientError::UnexpectedReply),
        }
    }

    pub async fn spawn(
        &self,
        launch: LaunchIdentity,
        target: SpawnTarget,
    ) -> Result<SessionId, ClientError> {
        match self
            .request(Request::Spawn {
                launch,
                target: Box::new(target),
            })
            .await?
        {
            Response::Spawned { id } => Ok(id),
            _ => Err(ClientError::UnexpectedReply),
        }
    }

    pub async fn write(&self, id: SessionId, bytes: &[u8]) -> Result<(), ClientError> {
        let (request_id, receiver) = self.register()?;
        let frame = encode_input(request_id, id, bytes);
        match self.exchange(request_id, receiver, frame).await? {
            Reply::Response(Response::Done) => Ok(()),
            _ => Err(ClientError::UnexpectedReply),
        }
    }

    pub async fn resize(&self, id: SessionId, cols: u16, rows: u16) -> Result<(), ClientError> {
        self.request_done(Request::Resize { id, cols, rows }).await
    }

    pub async fn kill(&self, id: SessionId) -> Result<(), ClientError> {
        self.request_done(Request::Kill { id }).await
    }

    pub async fn list(&self) -> Result<Vec<SessionInfo>, ClientError> {
        match self.request(Request::List).await? {
            Response::Sessions { sessions } => Ok(sessions),
            _ => Err(ClientError::UnexpectedReply),
        }
    }

    pub async fn attach(&self, id: SessionId) -> Result<Attached, ClientError> {
        let (request_id, receiver) = self.register()?;
        let frame = encode_control(&ClientMessage::Request {
            request_id,
            request: Request::Attach { id },
        })?;
        match self.exchange(request_id, receiver, frame).await? {
            Reply::Snapshot(header, replay) => Ok(Attached {
                alternate_screen: header.alternate_screen,
                shell: header.shell,
                replay,
            }),
            _ => Err(ClientError::UnexpectedReply),
        }
    }

    /// No output for the session arrives after this resolves.
    pub async fn detach(&self, id: SessionId) -> Result<(), ClientError> {
        self.request_done(Request::Detach { id }).await
    }

    /// Reports output bytes this client has finished with. Never answered.
    pub fn ack(&self, id: SessionId, bytes: usize) {
        if let Ok(frame) = encode_control(&ClientMessage::Ack { id, bytes }) {
            let _ = self.outgoing.send(frame);
        }
    }

    pub async fn task_output(
        &self,
        id: SessionId,
        query: OutputQuery,
    ) -> Result<OutputPage, ClientError> {
        match self.request(Request::TaskOutput { id, query }).await? {
            Response::TaskOutput { page } => Ok(page),
            _ => Err(ClientError::UnexpectedReply),
        }
    }

    /// `stop_all` kills every session first; without it the core refuses to
    /// exit while any session is running.
    pub async fn shutdown(&self, stop_all: bool) -> Result<(), ClientError> {
        self.request_done(Request::Shutdown { stop_all }).await
    }
}

fn dispatch(
    frame: crate::protocol::Frame,
    pending: &Pending,
    events: &mpsc::UnboundedSender<ClientEvent>,
) {
    let resolve = |request_id: RequestId, reply: Reply| {
        let sender = pending
            .lock()
            .ok()
            .and_then(|mut pending| pending.as_mut()?.remove(&request_id));
        if let Some(sender) = sender {
            let _ = sender.send(reply);
        }
    };
    match frame.kind {
        FrameKind::Output => {
            if let Some((id, bytes)) = decode_output(&frame.payload) {
                let _ = events.send(ClientEvent::Output {
                    id,
                    bytes: bytes.to_vec(),
                });
            }
        }
        FrameKind::Snapshot => {
            if let Some((request_id, _, header, replay)) = decode_snapshot(&frame.payload) {
                resolve(request_id, Reply::Snapshot(header, replay.to_vec()));
            }
        }
        FrameKind::Control => match serde_json::from_slice::<ServerMessage>(&frame.payload) {
            Ok(ServerMessage::Response {
                request_id,
                response,
            }) => resolve(request_id, Reply::Response(response)),
            Ok(ServerMessage::Error {
                request_id: Some(request_id),
                message,
            }) => resolve(request_id, Reply::Error(message)),
            Ok(ServerMessage::Event { event }) => {
                let _ = events.send(ClientEvent::Event(event));
            }
            _ => {}
        },
        FrameKind::Input => {}
    }
}

#[derive(Debug)]
pub enum ProbeError {
    NotRunning(io::Error),
    Rejected { version: u32, pid: u32 },
    Unanswered(String),
}

pub fn probe(socket: &Path, timeout: Duration) -> Result<CoreHello, ProbeError> {
    let mut stream = StdUnixStream::connect(socket).map_err(ProbeError::NotRunning)?;
    let unanswered = |error: &dyn std::fmt::Display| ProbeError::Unanswered(error.to_string());
    stream
        .set_read_timeout(Some(timeout))
        .and_then(|()| stream.set_write_timeout(Some(timeout)))
        .map_err(|error| unanswered(&error))?;
    let hello = hello_frame().map_err(|error| unanswered(&error))?;
    stream
        .write_all(&hello)
        .map_err(|error| unanswered(&error))?;
    let frame = read_frame_sync(&mut stream)
        .map_err(|error| unanswered(&error))?
        .ok_or_else(|| ProbeError::Unanswered("closed without answering".into()))?;
    if frame.kind != FrameKind::Control {
        return Err(ProbeError::Unanswered("unexpected frame".into()));
    }
    let message = serde_json::from_slice::<ServerMessage>(&frame.payload)
        .map_err(|error| unanswered(&error))?;
    match hello_reply(message) {
        Ok(hello) => Ok(hello),
        Err(ClientError::VersionMismatch { version, pid, .. }) => {
            Err(ProbeError::Rejected { version, pid })
        }
        Err(error) => Err(unanswered(&error)),
    }
}

/// Starts `<binary> core --socket <socket>` in its own session, detached from
/// the caller, with its output appended to `log`.
fn start_detached(socket: &Path, binary: &Path, log: &Path) -> io::Result<()> {
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(log)?;
    let mut command = Command::new(binary);
    command
        .arg("core")
        .arg("--socket")
        .arg(socket)
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log);
    // SAFETY: the hook runs in the forked child before exec and calls only
    // fork, setsid and _exit, which are async-signal-safe. The intermediate
    // child exits at once, so the core is never the caller's child and is
    // never left a zombie.
    unsafe {
        command.pre_exec(|| match libc::fork() {
            -1 => Err(io::Error::last_os_error()),
            0 => {
                if libc::setsid() == -1 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            }
            _ => libc::_exit(0),
        });
    }
    command.spawn()?.wait()?;
    Ok(())
}

pub fn ensure_running(socket: &Path, binary: &Path, log: &Path) -> Result<CoreHello, ClientError> {
    let reject = |version, pid| {
        ClientError::VersionMismatch {
        version,
        pid,
        message: format!(
            "the Sikemux core at {} (pid {pid}) speaks protocol version {version}, not {PROTOCOL_VERSION}",
            socket.display()
        ),
    }
    };
    match probe(socket, PROBE_TIMEOUT) {
        Ok(hello) => return Ok(hello),
        Err(ProbeError::Rejected { version, pid }) => return Err(reject(version, pid)),
        Err(ProbeError::NotRunning(_) | ProbeError::Unanswered(_)) => {}
    }
    start_detached(socket, binary, log)?;
    let deadline = Instant::now() + START_TIMEOUT;
    loop {
        match probe(socket, PROBE_TIMEOUT) {
            Ok(hello) => return Ok(hello),
            Err(ProbeError::Rejected { version, pid }) => return Err(reject(version, pid)),
            Err(_) if Instant::now() >= deadline => {
                return Err(ClientError::StartTimeout(START_TIMEOUT))
            }
            Err(_) => std::thread::sleep(START_POLL),
        }
    }
}

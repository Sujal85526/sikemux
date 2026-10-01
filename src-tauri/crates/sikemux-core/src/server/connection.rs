use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use sikemux_pty::validate_pty_dimensions;
use tokio::io::{AsyncWriteExt, BufReader, BufWriter};
use tokio::net::unix::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::UnixStream;
use tokio::sync::{mpsc, Notify};

use crate::protocol::{
    decode_input, encode_control, read_frame, ClientMessage, FrameKind, LaunchIdentity, Request,
    RequestId, Response, ServerMessage, SessionId, SpawnTarget, PROTOCOL, PROTOCOL_VERSION,
};

use super::prepare::{prepare_task, prepare_terminal};
use super::session::{self, PendingStart};
use super::{agent, chat, harness, upgrade, Core, CoreError, CoreResult};

pub(crate) type ClientId = u64;

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
/// A client that stops reading entirely is cut off rather than buffered for.
const MAX_CLIENT_BACKLOG: usize = 64 * 1024 * 1024;
const SHUTDOWN_FLUSH: Duration = Duration::from_secs(1);

pub(crate) struct ClientConn {
    pub id: ClientId,
    frames: mpsc::UnboundedSender<Arc<[u8]>>,
    queued: AtomicUsize,
    closed: AtomicBool,
    kick: Notify,
    subscriptions: Mutex<HashSet<SessionId>>,
}

impl ClientConn {
    pub(crate) fn send(&self, frame: Arc<[u8]>) -> bool {
        if self.closed.load(Ordering::Acquire) {
            return false;
        }
        let queued = self.queued.fetch_add(frame.len(), Ordering::AcqRel) + frame.len();
        if queued > MAX_CLIENT_BACKLOG {
            self.close();
            return false;
        }
        if self.frames.send(frame).is_err() {
            self.closed.store(true, Ordering::Release);
            return false;
        }
        true
    }

    pub(crate) fn close(&self) {
        self.closed.store(true, Ordering::Release);
        self.kick.notify_one();
    }

    pub(crate) fn send_message(&self, message: &ServerMessage) {
        if let Ok(frame) = encode_control(message) {
            self.send(frame.into());
        }
    }

    pub(crate) fn respond(&self, request_id: RequestId, result: CoreResult<Response>) {
        self.send_message(&match result {
            Ok(response) => ServerMessage::Response {
                request_id,
                response,
            },
            Err(error) => ServerMessage::Error {
                request_id: Some(request_id),
                message: error.to_string(),
            },
        });
    }

    pub(crate) fn note_subscription(&self, id: SessionId, subscribed: bool) {
        if let Ok(mut subscriptions) = self.subscriptions.lock() {
            if subscribed {
                subscriptions.insert(id);
            } else {
                subscriptions.remove(&id);
            }
        }
    }

    pub(crate) fn take_subscriptions(&self) -> HashSet<SessionId> {
        self.subscriptions
            .lock()
            .map(|mut subscriptions| std::mem::take(&mut *subscriptions))
            .unwrap_or_default()
    }

    pub(crate) async fn wait_flushed(&self, limit: Duration) {
        let deadline = Instant::now() + limit;
        while self.queued.load(Ordering::Acquire) > 0 && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }
}

async fn write_direct(writer: &mut BufWriter<OwnedWriteHalf>, message: &ServerMessage) {
    if let Ok(frame) = encode_control(message) {
        let _ = writer.write_all(&frame).await;
        let _ = writer.flush().await;
    }
}

async fn handshake(
    core: &Arc<Core>,
    reader: &mut BufReader<OwnedReadHalf>,
    writer: &mut BufWriter<OwnedWriteHalf>,
) -> bool {
    let frame = match tokio::time::timeout(HANDSHAKE_TIMEOUT, read_frame(reader)).await {
        Ok(Ok(Some(frame))) if frame.kind == FrameKind::Control => frame,
        Ok(Ok(Some(frame))) if frame.kind == FrameKind::Frozen => {
            upgrade::answer(core, &frame.payload, writer).await;
            return false;
        }
        _ => return false,
    };
    // A client that connected while the core hands itself over talks to the
    // replacement instead.
    if core.is_frozen() {
        return false;
    }
    let pid = std::process::id();
    match serde_json::from_slice::<ClientMessage>(&frame.payload) {
        Ok(ClientMessage::Hello { protocol, version })
            if protocol == PROTOCOL && version == PROTOCOL_VERSION =>
        {
            write_direct(
                writer,
                &ServerMessage::HelloAck {
                    protocol: PROTOCOL.into(),
                    version: PROTOCOL_VERSION,
                    pid,
                    build: core.build.clone(),
                },
            )
            .await;
            true
        }
        Ok(ClientMessage::Hello { protocol, version }) => {
            write_direct(
                writer,
                &ServerMessage::HelloRejected {
                    protocol: PROTOCOL.into(),
                    version: PROTOCOL_VERSION,
                    pid,
                    message: format!(
                        "this core speaks {PROTOCOL} version {PROTOCOL_VERSION}, the client asked for {protocol} version {version}"
                    ),
                },
            )
            .await;
            false
        }
        _ => {
            write_direct(
                writer,
                &ServerMessage::Error {
                    request_id: None,
                    message: "expected a hello".into(),
                },
            )
            .await;
            false
        }
    }
}

pub(crate) async fn serve_client(core: Arc<Core>, stream: UnixStream) {
    let (read_half, write_half) = stream.into_split();
    let mut reader = BufReader::new(read_half);
    let mut writer = BufWriter::with_capacity(64 * 1024, write_half);
    if !handshake(&core, &mut reader, &mut writer).await {
        return;
    }
    let (frames, queue) = mpsc::unbounded_channel();
    let client = Arc::new(ClientConn {
        id: core.next_client_id.fetch_add(1, Ordering::Relaxed),
        frames,
        queued: AtomicUsize::new(0),
        closed: AtomicBool::new(false),
        kick: Notify::new(),
        subscriptions: Mutex::new(HashSet::new()),
    });
    core.register_client(client.clone());
    let (work, work_queue) = mpsc::unbounded_channel();
    tokio::select! {
        _ = read_requests(&core, &client, &mut reader, work) => {}
        _ = write_frames(&mut writer, queue, &client) => {}
        _ = run_requests(&core, &client, work_queue) => {}
        _ = client.kick.notified() => {}
    }
    core.unregister_client(&client);
}

async fn write_frames(
    writer: &mut BufWriter<OwnedWriteHalf>,
    mut queue: mpsc::UnboundedReceiver<Arc<[u8]>>,
    client: &ClientConn,
) -> std::io::Result<()> {
    while let Some(frame) = queue.recv().await {
        let mut written = frame.len();
        writer.write_all(&frame).await?;
        while let Ok(frame) = queue.try_recv() {
            written += frame.len();
            writer.write_all(&frame).await?;
        }
        writer.flush().await?;
        client.queued.fetch_sub(written, Ordering::AcqRel);
    }
    Ok(())
}

async fn read_requests(
    core: &Arc<Core>,
    client: &Arc<ClientConn>,
    reader: &mut BufReader<OwnedReadHalf>,
    work: mpsc::UnboundedSender<(RequestId, Request)>,
) {
    while let Ok(Some(frame)) = read_frame(reader).await {
        match frame.kind {
            FrameKind::Control => match serde_json::from_slice::<ClientMessage>(&frame.payload) {
                Ok(ClientMessage::Ack { id, bytes }) => {
                    if let Some(session) = core.session(id) {
                        session::ack(&session, client.id, bytes);
                    }
                }
                Ok(ClientMessage::Request {
                    request_id,
                    request,
                }) => {
                    if work.send((request_id, request)).is_err() {
                        return;
                    }
                }
                Ok(ClientMessage::WindowReply { call_id, answer }) => {
                    core.window.answer(client.id, call_id, answer);
                }
                Ok(ClientMessage::WindowOpenClosed { call_id }) => {
                    core.window.open_closed(client.id, call_id);
                }
                Ok(ClientMessage::Hello { .. }) => client.send_message(&ServerMessage::Error {
                    request_id: None,
                    message: "the handshake is already done".into(),
                }),
                Err(error) => client.send_message(&ServerMessage::Error {
                    request_id: None,
                    message: format!("unreadable message: {error}"),
                }),
            },
            FrameKind::Input => {
                let Some((request_id, id, bytes)) = decode_input(&frame.payload) else {
                    return;
                };
                if core.is_frozen() {
                    client.respond(request_id, Err(upgrade::UPDATING.into()));
                    continue;
                }
                let Some(target) = core.session(id) else {
                    client.respond(request_id, Err("invalid argument: pty not found".into()));
                    continue;
                };
                agent::note_input(core, &target, bytes);
                let reply_to = client.clone();
                session::queue_input(
                    &target,
                    bytes.to_vec(),
                    Box::new(move |result| {
                        reply_to.respond(
                            request_id,
                            result.map(|()| Response::Done).map_err(CoreError::from),
                        );
                    }),
                );
            }
            FrameKind::Output | FrameKind::Snapshot | FrameKind::Frozen => return,
        }
    }
}

pub(crate) async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> CoreResult<T> + Send + 'static,
) -> CoreResult<T> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| CoreError::from(format!("pty: worker failed: {error}")))?
}

fn session_or_missing(core: &Core, id: SessionId) -> CoreResult<Arc<session::Session>> {
    core.session(id)
        .ok_or_else(|| CoreError::from("invalid argument: pty not found"))
}

/// Requests from one client run in order, except the slow ones (spawn, kill,
/// task output, shutdown), which run alongside so they hold nothing up.
async fn run_requests(
    core: &Arc<Core>,
    client: &Arc<ClientConn>,
    mut queue: mpsc::UnboundedReceiver<(RequestId, Request)>,
) {
    while let Some((request_id, request)) = queue.recv().await {
        let core = core.clone();
        let client = client.clone();
        if core.is_frozen() {
            client.respond(request_id, Err(upgrade::UPDATING.into()));
            continue;
        }
        match request {
            Request::Spawn { launch, target } => {
                tokio::spawn(async move {
                    match spawn(core.clone(), launch, target).await {
                        Ok(pending) => {
                            let id = pending.id();
                            client.respond(request_id, Ok(Response::Spawned { id }));
                            let stopped = pending
                                .task()
                                .is_some_and(|task| core.harness.session_started(id, task));
                            pending.start(&core);
                            if stopped {
                                if let Some(target) = core.take_session_for_kill(id) {
                                    let killing = core.clone();
                                    let _ = blocking(move || {
                                        session::kill(&killing, &target);
                                        Ok(())
                                    })
                                    .await;
                                }
                            }
                        }
                        Err(error) => client.respond(request_id, Err(error)),
                    }
                });
            }
            Request::Kill { id } => {
                tokio::spawn(async move {
                    let result = match core.take_session_for_kill(id) {
                        Some(target) => {
                            let core = core.clone();
                            blocking(move || {
                                session::kill(&core, &target);
                                Ok(())
                            })
                            .await
                        }
                        None => Ok(()),
                    };
                    client.respond(request_id, result.map(|()| Response::Done));
                });
            }
            Request::TaskOutput { id, query } => {
                tokio::spawn(async move {
                    let result = match session_or_missing(&core, id) {
                        Ok(target) => blocking(move || session::task_output(&target, &query)).await,
                        Err(_) => Err("Task output expired or task no longer exists".into()),
                    };
                    client.respond(request_id, result.map(|page| Response::TaskOutput { page }));
                });
            }
            Request::Shutdown { stop_all } => {
                tokio::spawn(shutdown(core, client, request_id, stop_all));
            }
            Request::StopAll => {
                tokio::spawn(async move {
                    let draining = core.clone();
                    let result = blocking(move || {
                        draining.drain();
                        Ok(())
                    })
                    .await;
                    client.respond(request_id, result.map(|()| Response::Done));
                });
            }
            Request::RegisterWindow => {
                core.window.register(client.clone());
                client.respond(request_id, Ok(Response::Done));
            }
            Request::HarnessAwaitingTrust { execution_id } => {
                core.harness.awaiting_trust(&execution_id);
                client.respond(request_id, Ok(Response::Done));
            }
            Request::HarnessStopRuns { selector } => {
                tokio::spawn(async move {
                    harness::stop_runs(&core, selector).await;
                    client.respond(request_id, Ok(Response::Done));
                });
            }
            Request::Configure { manifest_dir } => {
                tokio::spawn(async move {
                    let result = blocking(move || core.configure_manifests(manifest_dir)).await;
                    client.respond(
                        request_id,
                        result.map(|report| Response::Manifests { report }),
                    );
                });
            }
            Request::ReloadManifests => {
                tokio::spawn(async move {
                    let result = blocking(move || core.reload_manifests()).await;
                    client.respond(
                        request_id,
                        result.map(|report| Response::Manifests { report }),
                    );
                });
            }
            Request::ListManifests => {
                let result = core.manifest_report();
                client.respond(
                    request_id,
                    result.map(|report| Response::Manifests { report }),
                );
            }
            Request::ExplainAgentDetection { agent_id } => {
                let result = match core.agent_session(&agent_id) {
                    Some(target) => {
                        let explaining = core.clone();
                        blocking(move || {
                            let registry = explaining.detection.read().map_err(|_| {
                                CoreError::from("agent detection registry lock poisoned")
                            })?;
                            agent::explain(&registry, &target)
                        })
                        .await
                    }
                    None => Err("invalid argument: agent has no live terminal".into()),
                };
                client.respond(
                    request_id,
                    result.map(|explain| Response::DetectionExplain {
                        explain: Box::new(explain),
                    }),
                );
            }
            Request::Attach { id } => {
                let result = match session_or_missing(&core, id) {
                    Ok(target) => {
                        let subscriber = client.clone();
                        blocking(move || session::attach(&target, &subscriber, request_id)).await
                    }
                    Err(error) => Err(error),
                };
                if let Err(error) = result {
                    client.respond(request_id, Err(error));
                }
            }
            Request::Subscribe { id } => {
                let result = match session_or_missing(&core, id) {
                    Ok(target) => {
                        let subscriber = client.clone();
                        blocking(move || session::subscribe(&target, &subscriber, request_id)).await
                    }
                    Err(error) => Err(error),
                };
                if let Err(error) = result {
                    client.respond(request_id, Err(error));
                }
            }
            Request::ResetModes { id } => {
                let result = match session_or_missing(&core, id) {
                    Ok(target) => blocking(move || session::reset_modes(&target)).await,
                    Err(error) => Err(error),
                };
                client.respond(request_id, result.map(|()| Response::Done));
            }
            Request::Detach { id } => {
                if let Some(target) = core.session(id) {
                    let client_id = client.id;
                    let _ = blocking(move || {
                        session::detach(&target, client_id);
                        Ok(())
                    })
                    .await;
                }
                client.note_subscription(id, false);
                client.respond(request_id, Ok(Response::Done));
            }
            Request::Resize { id, cols, rows } => {
                let result = match validate_pty_dimensions(cols, rows) {
                    Ok(()) => match session_or_missing(&core, id) {
                        Ok(target) => blocking(move || session::resize(&target, cols, rows)).await,
                        Err(error) => Err(error),
                    },
                    Err(error) => Err(error.into()),
                };
                client.respond(request_id, result.map(|()| Response::Done));
            }
            Request::List => {
                let mut sessions: Vec<_> = core.all_sessions().iter().map(|s| s.info()).collect();
                sessions.sort_by_key(|info| info.id);
                client.respond(request_id, Ok(Response::Sessions { sessions }));
            }
            Request::AcpStart { launch } => {
                tokio::spawn(async move {
                    let result = chat::start(&core, *launch, Some(&client)).await;
                    client.respond(
                        request_id,
                        result.map(|start| Response::ChatStarted { start }),
                    );
                });
            }
            Request::AcpAttach { agent_id } => {
                tokio::spawn(async move {
                    chat::attach(&core, &client, request_id, &agent_id).await;
                });
            }
            Request::AcpList => {
                client.respond(
                    request_id,
                    Ok(Response::Chats {
                        chats: core.chats.list(),
                    }),
                );
            }
            Request::AcpPrompt {
                agent_id,
                text,
                paths,
                context,
            } => {
                let result = chat::prompt(&core, &agent_id, text, paths, context);
                client.respond(request_id, result.map(|()| Response::Done));
            }
            Request::AcpSteer {
                agent_id,
                text,
                paths,
                context,
            } => {
                tokio::spawn(async move {
                    let result = chat::steer(&core, &agent_id, text, paths, context).await;
                    client.respond(
                        request_id,
                        result.map(|outcome| Response::Steered { outcome }),
                    );
                });
            }
            Request::AcpCancel { agent_id } => {
                let result = chat::cancel(&core, &agent_id);
                client.respond(request_id, result.map(|()| Response::Done));
            }
            Request::AcpStopTask { agent_id, task_id } => {
                let result = chat::stop_task(&core, &agent_id, task_id);
                client.respond(request_id, result.map(|()| Response::Done));
            }
            Request::AcpPermissionReply {
                agent_id,
                request_id: permission,
                option_id,
            } => {
                let result = chat::reply_permission(&core, &agent_id, &permission, option_id);
                client.respond(request_id, result.map(|()| Response::Done));
            }
            Request::AcpStop { agent_id } => {
                core.chats.stop(&agent_id);
                client.respond(request_id, Ok(Response::Done));
            }
            Request::AcpSetPermissionMode { agent_id, mode } => {
                tokio::spawn(async move {
                    let result = chat::set_permission_mode(&core, &agent_id, mode).await;
                    client.respond(request_id, result.map(|()| Response::Done));
                });
            }
            Request::AcpSetConfig {
                agent_id,
                config_id,
                value,
            } => {
                tokio::spawn(async move {
                    let result = chat::set_config(&core, &agent_id, config_id, value).await;
                    client.respond(
                        request_id,
                        result.map(|value| Response::ChatConfig { value }),
                    );
                });
            }
        }
    }
}

async fn spawn(
    core: Arc<Core>,
    launch: LaunchIdentity,
    target: Box<SpawnTarget>,
) -> CoreResult<PendingStart> {
    blocking(move || {
        let prepared = match *target {
            SpawnTarget::Terminal(spawn) => prepare_terminal(&launch, spawn)?,
            SpawnTarget::Task { request } => prepare_task(&launch, request)?,
        };
        session::spawn_session(&core, prepared)
    })
    .await
}

async fn shutdown(core: Arc<Core>, client: Arc<ClientConn>, request_id: RequestId, stop_all: bool) {
    if stop_all {
        let draining = core.clone();
        let _ = blocking(move || {
            draining.drain();
            Ok(())
        })
        .await;
    } else {
        let running = core.running_sessions() + core.chats.count();
        if running > 0 {
            client.respond(
                request_id,
                Err(format!("the core still has {running} running sessions").into()),
            );
            return;
        }
    }
    client.respond(request_id, Ok(Response::Done));
    client.wait_flushed(SHUTDOWN_FLUSH).await;
    core.begin_shutdown();
}

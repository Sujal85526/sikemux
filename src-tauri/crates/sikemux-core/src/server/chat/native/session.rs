//! The part of a chat that is the same for every agent the core speaks to in
//! its own protocol: turns, permission requests, accounts and starting the
//! agent again under the chat.

use std::os::fd::OwnedFd;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot};
use uuid::Uuid;

use crate::acp::account::{self, Failure, FailureKind, SignIn};
use crate::acp::{permission, SessionEnd};
use crate::protocol::{ChatContext, ChatEventKind, ChatLaunch, ChatStart};

use super::super::rebind::{
    error_message, next_account, on_account, switch_notice, Carried, Outcome, Rebind, Replay,
};
use super::super::{Asked, Chat, ChatCommand};
use super::process::{AgentRecord, Lines, Process, Released, Writer};

/// What the person sent, for the agent to read in its own form.
#[derive(Clone)]
pub(crate) struct Prompt {
    pub message_id: Option<String>,
    pub text: String,
    pub paths: Vec<String>,
    pub context: Vec<ChatContext>,
}

impl From<&Replay> for Prompt {
    fn from(replay: &Replay) -> Self {
        Self {
            message_id: replay.message_id.clone(),
            text: replay.text.clone(),
            paths: replay.paths.clone(),
            context: replay.context.clone(),
        }
    }
}

/// The most of any one text an update carries. The chat shows only the first
/// few hundred lines of what a tool printed, and a long chat loaded again
/// would otherwise send all of it.
const MAX_TEXT: usize = 128 * 1024;
/// The largest picture an update carries, as base64. The chat keeps none
/// bigger.
const MAX_IMAGE: usize = 2 * 1024 * 1024;

/// Cuts every text in `value` down to what the chat can show.
fn slim(value: &mut Value) {
    match value {
        Value::String(text) if text.len() > MAX_TEXT => {
            let mut end = MAX_TEXT;
            while !text.is_char_boundary(end) {
                end -= 1;
            }
            text.truncate(end);
            text.push('…');
        }
        Value::Array(items) => items.iter_mut().for_each(slim),
        Value::Object(fields) => {
            let picture = fields.get("data").and_then(Value::as_str).map(str::len);
            if picture.is_some_and(|len| len > MAX_IMAGE) {
                fields.remove("data");
            }
            for (key, field) in fields.iter_mut() {
                if key != "data" {
                    slim(field);
                }
            }
        }
        _ => {}
    }
}

/// How a turn this side started ended.
pub(crate) enum TurnEnd {
    /// The `turn_completed` payload, such as `{"stopReason": "end_turn"}`.
    Completed(Value),
    /// The agent could not finish it, and said why.
    Failed {
        failure: Failure,
        response: Option<Value>,
    },
    /// The agent turned the prompt down with this error.
    Refused(String),
    /// The agent can take no more turns in this session, for this reason, and
    /// is started again.
    Broken(String),
}

/// A turn that failed in a way a new agent process or another account may fix.
pub(crate) struct Failed {
    turn: u64,
    failure: Failure,
    response: Option<Value>,
}

/// What an agent's reader tells the chat. Cheap to clone, and safe to use
/// from any task.
#[derive(Clone)]
pub(crate) struct Sink {
    chat: Arc<Chat>,
    failed: mpsc::UnboundedSender<Failed>,
    broken: mpsc::UnboundedSender<String>,
    account: Option<String>,
    /// Quiet while a session loaded under a running chat replays history the
    /// chat already shows.
    quiet: Arc<std::sync::atomic::AtomicBool>,
}

impl Sink {
    pub fn update(&self, session_id: &str, mut update: Value) {
        if self.quiet.load(Ordering::Acquire) {
            return;
        }
        slim(&mut update);
        self.chat.emit(
            ChatEventKind::SessionUpdate,
            json!({ "sessionId": session_id, "update": update }),
        );
    }

    /// Says in the chat that something the person asked for went wrong.
    pub fn error(&self, message: impl std::fmt::Display) {
        self.chat.emit(ChatEventKind::Error, error_message(message));
    }

    /// Whether this start loads the session again under a running chat.
    pub fn reloading(&self) -> bool {
        self.quiet.load(Ordering::Acquire)
    }

    /// The session has loaded, so what the agent says from now on is new to
    /// the chat.
    pub fn loaded(&self) {
        self.quiet.store(false, Ordering::Release);
    }

    /// Whether the provider has a saved session to load.
    pub fn has_answered(&self) -> bool {
        self.chat.has_answered()
    }

    /// Whether a turn this side prompted is being answered.
    pub fn running(&self) -> bool {
        self.chat.running.load(Ordering::Acquire)
    }

    /// The agent began work nobody here asked for, such as answering a
    /// background task that finished.
    pub fn work_started(&self) {
        self.chat.work_started();
    }

    /// The work nobody here asked for is over.
    pub fn work_ended(&self, stop_reason: &str) {
        self.chat.work_ended(stop_reason);
    }

    /// Settles turn `turn`, or hands a failure another account may fix to
    /// the chat's loop to decide on, with the turn still running.
    pub fn end_turn(&self, turn: u64, end: TurnEnd) {
        let chat = &self.chat;
        chat.unprompted.store(false, Ordering::Release);
        chat.cancel_permissions();
        let settle = || chat.running.store(false, Ordering::Release);
        match end {
            TurnEnd::Completed(payload) => {
                settle();
                chat.answered.store(true, Ordering::Release);
                chat.emit(ChatEventKind::TurnCompleted, payload);
            }
            TurnEnd::Failed { failure, response } if failure.kind != FailureKind::Other => {
                let _ = self.failed.send(Failed {
                    turn,
                    failure,
                    response,
                });
            }
            TurnEnd::Failed { failure, response } => {
                settle();
                chat.emit(
                    ChatEventKind::TurnCompleted,
                    response.unwrap_or_else(|| json!({ "stopReason": "end_turn" })),
                );
                chat.emit(
                    ChatEventKind::Error,
                    failure.payload(self.account.as_deref()),
                );
            }
            TurnEnd::Refused(message) => {
                settle();
                chat.emit(ChatEventKind::Error, error_message(message));
            }
            TurnEnd::Broken(reason) => {
                settle();
                let _ = self.broken.send(reason);
            }
        }
    }

    /// The person's message `text` went into the running turn.
    pub fn prompted(&self, text: &str, paths: &[String]) {
        self.chat.feed.prompted(NOBODY, None, text, paths);
    }

    /// Asks the person about a tool call. `request` is shaped as an ACP
    /// permission request: the session, the tool call and its `options`.
    /// `reply` is what the backend needs to answer the agent, kept with the
    /// question so a core that takes the chat over can answer it too.
    /// Answers with the chosen option's id, or none when it was cancelled.
    pub async fn ask(&self, mut request: Value, reply: Value) -> Option<String> {
        if self.chat.approves() {
            if let Some(option_id) = permission::approval(&request) {
                return Some(option_id);
            }
        }
        let option_ids = request
            .get("options")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|option| Some(option.get("optionId")?.as_str()?.to_owned()))
            .collect();
        let request_id = Uuid::new_v4().to_string();
        if let Some(object) = request.as_object_mut() {
            object.insert("requestId".into(), Value::String(request_id.clone()));
        }
        let (answer, answered) = oneshot::channel();
        if self
            .chat
            .hold_permission(request_id, option_ids, answer, request.clone(), reply)
        {
            self.chat.emit(ChatEventKind::PermissionRequest, request);
        }
        answered.await.ok().flatten()
    }
}

/// No client: a message that went in on its own, which every client is told of.
const NOBODY: crate::server::connection::ClientId = 0;

/// The session an agent opened, as the chat reads it.
pub(crate) struct Opened {
    pub session_id: String,
    pub capabilities: Value,
    pub setup: Value,
}

/// One agent the core speaks to in its own protocol.
pub(crate) trait Backend: Sized + Send {
    /// Starts the agent and opens the chat's session, or loads the one it
    /// resumes, replaying its history through `sink`.
    fn start(
        launch: &ChatLaunch,
        sink: Sink,
    ) -> impl std::future::Future<Output = Result<(Self, Opened), String>> + Send;

    /// Sends a prompt that begins turn `turn`. How it ends is told to the
    /// sink.
    fn prompt(
        &mut self,
        turn: u64,
        prompt: Prompt,
    ) -> impl std::future::Future<Output = Result<(), String>> + Send;

    /// Puts a message into the running turn. `injected` once it is in,
    /// `promptRequired` when the turn ended first. The answer is waited on
    /// apart from the chat's other commands, so a stop sent right after a
    /// steer is never held up behind it.
    fn steer(
        &mut self,
        prompt: Prompt,
    ) -> impl std::future::Future<Output = Result<String, String>> + Send + 'static;

    /// Asks the running turn to stop.
    fn cancel(&mut self) -> impl std::future::Future<Output = Result<(), String>> + Send;

    /// Applies one of the app's permission modes.
    fn set_permission_mode(
        &mut self,
        mode: &str,
    ) -> impl std::future::Future<Output = Result<(), String>> + Send;

    /// Changes a session option, answering with the options as they now are.
    fn set_config(
        &mut self,
        config_id: &str,
        value: &str,
    ) -> impl std::future::Future<Output = Result<Value, String>> + Send;

    fn stop_task(
        &mut self,
        task_id: &str,
    ) -> impl std::future::Future<Output = Result<(), String>> + Send;

    /// Takes the conversation back to before the person's message `message_id`,
    /// answering with the session it goes on in when that is a new one.
    fn rewind(
        &mut self,
        message_id: &str,
    ) -> impl std::future::Future<Output = Result<Option<String>, String>> + Send;

    /// Resolves once the agent is gone, with why.
    fn closed(&self) -> impl std::future::Future<Output = String> + Send;

    /// Whether a new agent process can load this session, so the chat can go
    /// on in one after a sign-in or on another account.
    fn reloadable(&self) -> bool {
        true
    }

    /// Lets go of the agent without stopping it, answering with what a core
    /// that takes it up needs: this side's state as plain data, and the
    /// agent's process. On failure the agent is stopped.
    fn release(self)
        -> impl std::future::Future<Output = Result<(Value, Released), String>> + Send;

    /// Takes up an agent an earlier core released, from the state `release`
    /// answered. `asked` are the questions still put to the person, each with
    /// its reply and the person's answer to come.
    fn adopt(
        launch: &ChatLaunch,
        sink: Sink,
        state: Value,
        agent: (Process, Writer, Lines),
        asked: Vec<(Value, oneshot::Receiver<Option<String>>)>,
    ) -> Result<Self, String>;
}

/// Where the chat's loop stands, as plain data, for a core that takes the
/// chat over.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionState {
    session_id: String,
    setup: Value,
    capabilities: Value,
    turn: u64,
    last_prompt: Option<Replay>,
    failed_prompt: Option<Replay>,
    exhausted: Vec<String>,
    signed_in_again: bool,
    signed_in_at_start: Option<SignIn>,
    reloadable: bool,
}

/// A chat let go of by its loop.
pub(crate) struct Handed {
    pub session: SessionState,
    pub backend: Value,
    pub released: Released,
}

/// A chat another core let go of, to take up.
pub(crate) struct Adopted {
    pub session: SessionState,
    pub backend: Value,
    pub agent: AgentRecord,
    pub pipes: [OwnedFd; 3],
    pub asked: Vec<Asked>,
}

/// How the chat's loop gets its agent.
pub(crate) enum Begin {
    /// Starts the agent, or starts it again under the chat. `notice` is said
    /// in the transcript once the agent is up.
    Start {
        rebind: Option<Box<Rebind>>,
        notice: Option<Value>,
    },
    Adopt(Box<Adopted>),
}

pub(crate) async fn run<B: Backend>(
    chat: Arc<Chat>,
    launch: ChatLaunch,
    commands: &mut mpsc::UnboundedReceiver<ChatCommand>,
    opening: Begin,
) -> Result<Outcome, String> {
    let provider = launch.provider.clone();
    let (failed_tx, mut failed_rx) = mpsc::unbounded_channel::<Failed>();
    let (broken_tx, mut broken_rx) = mpsc::unbounded_channel::<String>();
    let sink = |quiet: bool| Sink {
        chat: chat.clone(),
        failed: failed_tx.clone(),
        broken: broken_tx.clone(),
        account: launch.account.as_ref().map(|account| account.id.clone()),
        quiet: Arc::new(std::sync::atomic::AtomicBool::new(quiet)),
    };
    let (mut backend, mut state, replay) = match opening {
        Begin::Start { rebind, notice } => {
            chat.emit(ChatEventKind::Status, json!({ "state": "starting" }));
            let signed_in_at_start = account::signed_in(&provider, &launch.env);
            let Carried {
                replay,
                exhausted,
                signed_in_again,
                notice: carried,
                quiet_load,
            } = Carried::from(rebind);
            let sink = sink(quiet_load);
            chat.emit(ChatEventKind::Status, json!({ "state": "initializing" }));
            let (backend, opened) = B::start(&launch, sink.clone()).await?;
            sink.loaded();
            let state = SessionState {
                session_id: opened.session_id,
                setup: opened.setup,
                capabilities: opened.capabilities,
                turn: 0,
                last_prompt: None,
                failed_prompt: None,
                exhausted,
                signed_in_again,
                signed_in_at_start,
                reloadable: backend.reloadable(),
            };
            let start = state.start();
            chat.mark_ready(start.clone());
            chat.emit(
                ChatEventKind::Ready,
                serde_json::to_value(&start).unwrap_or_else(|_| json!({})),
            );
            for update in carried.into_iter().chain(notice) {
                sink.update(&state.session_id, update);
            }
            (backend, state, replay)
        }
        Begin::Adopt(adopted) => {
            let Adopted {
                session,
                backend: kept,
                agent,
                pipes,
                asked,
            } = *adopted;
            let asked = asked
                .into_iter()
                .map(|asked| (asked.reply.clone(), chat.hold_again(asked)))
                .collect();
            let [stdin, stdout, stderr] = pipes;
            let adopted = Process::adopt(&agent, stdin, stdout, stderr)
                .inspect_err(|_| super::process::kill_group(agent.pid))
                .and_then(|process| B::adopt(&launch, sink(false), kept, process, asked));
            match adopted {
                Ok(backend) => {
                    chat.mark_ready(session.start());
                    (backend, session, None)
                }
                Err(error) => return Ok(not_taken_over(&chat, &launch, &error)),
            }
        }
    };

    let (stalled_tx, mut stalled_rx) = mpsc::unbounded_channel::<u64>();
    if let Some(replay) = replay {
        if let Some(from) = replay.announce {
            chat.feed.prompted(
                from,
                replay.message_id.as_deref(),
                &replay.text,
                &replay.paths,
            );
        }
        chat.running.store(true, Ordering::Release);
        state.turn += 1;
        begin(&chat, &mut backend, state.turn, Prompt::from(&replay)).await;
        state.last_prompt = Some(Replay {
            announce: None,
            ..replay
        });
    }

    let end = loop {
        chat.at_rest.store(true, Ordering::Release);
        let command = tokio::select! {
            command = commands.recv() => match command {
                Some(command) => command,
                None => break Outcome::Ended(SessionEnd::Requested),
            },
            reason = backend.closed() => {
                if chat.running.load(Ordering::Acquire) {
                    chat.emit(ChatEventKind::Error, error_message(&reason));
                }
                break Outcome::Ended(SessionEnd::Exited);
            }
            Some(reason) = broken_rx.recv() => {
                chat.emit(ChatEventKind::Error, error_message(reason));
                break Outcome::Ended(SessionEnd::Exited);
            }
            Some(failed) = failed_rx.recv() => {
                if failed.turn != state.turn {
                    continue;
                }
                let current = launch.account.as_ref().map(|account| account.id.clone());
                let retry = match failed.failure.kind {
                    FailureKind::SignIn if state.reloadable && !state.signed_in_again => chat
                        .relaunch(&launch)
                        .map(|launch| Rebind {
                            launch,
                            replay: state.last_prompt.clone(),
                            exhausted: state.exhausted.clone(),
                            signed_in_again: true,
                            notice: None,
                        }),
                    FailureKind::Limit if state.reloadable => {
                        let mut tried = state.exhausted.clone();
                        tried.extend(current.clone());
                        next_account(&provider, &launch, &tried).and_then(|next| {
                            let notice = switch_notice(&launch, next, "limit");
                            let moved = on_account(&provider, &launch, next);
                            chat.relaunch(&moved).map(|launch| Rebind {
                                launch,
                                replay: state.last_prompt.clone(),
                                exhausted: tried,
                                signed_in_again: false,
                                notice: Some(notice),
                            })
                        })
                    }
                    _ => None,
                };
                if let Some(rebind) = retry {
                    break Outcome::Rebind(Box::new(rebind));
                }
                chat.running.store(false, Ordering::Release);
                if let Some(response) = failed.response {
                    chat.emit(ChatEventKind::TurnCompleted, response);
                }
                chat.emit(ChatEventKind::Error, failed.failure.payload(current.as_deref()));
                state.failed_prompt = state.last_prompt.take();
                continue;
            }
            Some(stalled) = stalled_rx.recv() => {
                if chat.running.load(Ordering::Acquire) && state.turn == stalled {
                    chat.emit(
                        ChatEventKind::Error,
                        error_message("The agent did not stop, so its session was restarted"),
                    );
                    break Outcome::Ended(SessionEnd::Exited);
                }
                continue;
            }
        };
        chat.at_rest.store(false, Ordering::Release);
        match command {
            ChatCommand::Prompt {
                from,
                message_id,
                text,
                paths,
                context,
            } => {
                if chat.running.swap(true, Ordering::AcqRel) {
                    chat.emit(
                        ChatEventKind::Error,
                        error_message("wait for the current turn to finish"),
                    );
                    continue;
                }
                state.exhausted.clear();
                state.signed_in_again = false;
                state.failed_prompt = None;
                let replay = Replay {
                    announce: Some(from),
                    message_id,
                    text,
                    paths,
                    context,
                };
                // A sign-in made elsewhere since the agent started is only
                // read by a new agent process.
                let changed = account::signed_in(&provider, &launch.env);
                if state.reloadable
                    && changed.is_some()
                    && state.signed_in_at_start.is_some()
                    && changed != state.signed_in_at_start
                {
                    if let Some(launch) = chat.relaunch(&launch) {
                        break Outcome::Rebind(Box::new(Rebind {
                            launch,
                            replay: Some(replay),
                            exhausted: Vec::new(),
                            signed_in_again: false,
                            notice: None,
                        }));
                    }
                }
                chat.feed.prompted(
                    from,
                    replay.message_id.as_deref(),
                    &replay.text,
                    &replay.paths,
                );
                state.turn += 1;
                begin(&chat, &mut backend, state.turn, Prompt::from(&replay)).await;
                state.last_prompt = Some(Replay {
                    announce: None,
                    ..replay
                });
            }
            ChatCommand::Edit {
                from,
                message_id,
                text,
                paths,
                context,
                reply,
            } => {
                if chat.running.load(Ordering::Acquire) {
                    let _ =
                        reply.send(Err("Stop the current turn before editing a message".into()));
                    continue;
                }
                let moved = match backend.rewind(&message_id).await {
                    Ok(moved) => moved,
                    Err(error) => {
                        let _ = reply.send(Err(error));
                        continue;
                    }
                };
                chat.feed.rewound(from, &state.session_id, &message_id);
                if let Some(moved) = moved {
                    state.session_id = moved;
                    let start = state.start();
                    chat.mark_ready(start.clone());
                    chat.emit(
                        ChatEventKind::Ready,
                        serde_json::to_value(&start).unwrap_or_else(|_| json!({})),
                    );
                }
                let _ = reply.send(Ok(()));
                state.exhausted.clear();
                state.signed_in_again = false;
                state.failed_prompt = None;
                let replay = Replay {
                    announce: None,
                    message_id: Some(message_id),
                    text,
                    paths,
                    context,
                };
                chat.feed.prompted(
                    from,
                    replay.message_id.as_deref(),
                    &replay.text,
                    &replay.paths,
                );
                chat.running.store(true, Ordering::Release);
                state.turn += 1;
                begin(&chat, &mut backend, state.turn, Prompt::from(&replay)).await;
                state.last_prompt = Some(replay);
            }
            ChatCommand::SwitchAccount { account } => {
                if chat.running.load(Ordering::Acquire) {
                    chat.emit(
                        ChatEventKind::Error,
                        error_message("Stop the current turn before switching accounts"),
                    );
                    continue;
                }
                if !state.reloadable {
                    chat.emit(
                        ChatEventKind::Error,
                        error_message("This agent cannot carry a chat to another account"),
                    );
                    continue;
                }
                let moves = launch
                    .account
                    .as_ref()
                    .is_none_or(|current| current.id != account.id);
                let notice = moves.then(|| switch_notice(&launch, &account, "chosen"));
                let moved = on_account(&provider, &launch, &account);
                if let Some(launch) = chat.relaunch(&moved) {
                    let replay = state.failed_prompt.take();
                    if replay.is_some() {
                        chat.running.store(true, Ordering::Release);
                    }
                    break Outcome::Rebind(Box::new(Rebind {
                        launch,
                        replay,
                        exhausted: Vec::new(),
                        signed_in_again: false,
                        notice,
                    }));
                }
            }
            ChatCommand::SetPermissionMode { mode, reply } => {
                let result = if chat.running.load(Ordering::Acquire) {
                    Err("Stop the current turn before changing permissions".into())
                } else {
                    backend.set_permission_mode(&mode).await
                };
                if result.is_ok() {
                    chat.set_permission_mode(&mode);
                }
                let _ = reply.send(result);
            }
            ChatCommand::SetConfig {
                config_id,
                value,
                reply,
            } => {
                let result = if chat.running.load(Ordering::Acquire) {
                    Err("Stop the current turn before changing the model".into())
                } else {
                    backend.set_config(&config_id, &value).await
                };
                if let Ok(options) = &result {
                    state.setup["configOptions"] = options.clone();
                    chat.feed.set_setup(&state.setup);
                }
                let _ = reply.send(result.map(|options| json!({ "configOptions": options })));
            }
            ChatCommand::Steer {
                from,
                text,
                paths,
                context,
                reply,
            } => {
                if !chat.running.load(Ordering::Acquire) {
                    let _ = reply.send(Ok("promptRequired".to_owned()));
                    continue;
                }
                let prompt = Prompt {
                    message_id: None,
                    text,
                    paths,
                    context,
                };
                let steering = backend.steer(prompt.clone());
                let chat = chat.clone();
                tokio::spawn(async move {
                    let result = steering.await;
                    if result.as_deref() == Ok("injected") {
                        chat.feed.prompted(from, None, &prompt.text, &prompt.paths);
                    }
                    let _ = reply.send(result);
                });
            }
            ChatCommand::StopTask { task_id } => {
                if let Err(error) = backend.stop_task(&task_id).await {
                    chat.emit(ChatEventKind::Error, error_message(error));
                }
            }
            ChatCommand::Cancel => {
                let sent = backend.cancel().await;
                chat.cancel_sent(sent, state.turn, &stalled_tx);
            }
            ChatCommand::HandOver { reply } => {
                let released = backend.release().await;
                let handed = released.map(|(backend, released)| Handed {
                    session: state,
                    backend,
                    released,
                });
                // Nobody waits for it any more, so the agent is stopped
                // rather than left running unread.
                if let Err(Ok(handed)) = reply.send(handed) {
                    super::process::kill_group(handed.released.pid);
                }
                break Outcome::Released;
            }
        }
    };
    Ok(end)
}

impl SessionState {
    fn start(&self) -> ChatStart {
        ChatStart {
            session_id: self.session_id.clone(),
            capabilities: self.capabilities.clone(),
            setup: self.setup.clone(),
        }
    }
}

/// A chat whose agent this core could not take over: it goes on in a new
/// agent process on the same session, and says so.
fn not_taken_over(chat: &Chat, launch: &ChatLaunch, error: &str) -> Outcome {
    if chat.running.swap(false, Ordering::AcqRel) {
        chat.emit(
            ChatEventKind::TurnCompleted,
            json!({ "stopReason": "cancelled" }),
        );
    }
    chat.cancel_permissions();
    let notice = super::super::update_notice(error);
    match chat.relaunch(launch) {
        Some(launch) => Outcome::Rebind(Box::new(Rebind {
            launch,
            replay: None,
            exhausted: Vec::new(),
            signed_in_again: false,
            notice: Some(notice),
        })),
        None => {
            chat.emit(ChatEventKind::Error, error_message(error));
            Outcome::Ended(SessionEnd::Exited)
        }
    }
}

/// Starts turn `turn`, or says why it could not start.
async fn begin<B: Backend>(chat: &Arc<Chat>, backend: &mut B, turn: u64, prompt: Prompt) {
    chat.unprompted.store(false, Ordering::Release);
    chat.emit(ChatEventKind::TurnStarted, json!({}));
    if let Err(error) = backend.prompt(turn, prompt).await {
        chat.running.store(false, Ordering::Release);
        chat.emit(ChatEventKind::Error, error_message(error));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn long_texts_are_cut_and_pictures_kept_whole() {
        let long = "é".repeat(MAX_TEXT);
        let picture = "A".repeat(MAX_TEXT * 2);
        let mut update = json!({
            "rawOutput": long,
            "content": [{ "type": "image", "data": picture, "mimeType": "image/png" }],
            "huge": [{ "type": "image", "source": { "type": "base64", "data": "A".repeat(MAX_IMAGE + 1) } }],
        });
        slim(&mut update);
        let cut = update["rawOutput"].as_str().unwrap();
        assert!(cut.len() <= MAX_TEXT + '…'.len_utf8());
        assert!(cut.ends_with('…'));
        assert_eq!(
            update["content"][0]["data"].as_str().map(str::len),
            Some(MAX_TEXT * 2)
        );
        assert!(update["huge"][0]["source"].get("data").is_none());
    }
}

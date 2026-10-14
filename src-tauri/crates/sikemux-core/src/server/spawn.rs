//! What `agent_spawn` answers: an agent starting another as a full chat of
//! its own, or in a terminal the app opens, on its account and in its
//! permission mode, in a tab that does not move the person there. Each time
//! the new agent's turn ends, its final answer goes back to the agent that
//! started it.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use sikemux_pty::agent_detection::AgentKind;

use crate::cli::protocol::HarnessRequest;
use crate::protocol::{Event, WindowCall};

use super::chat;
use super::connection::blocking;
use super::follow::{self, TerminalAnswer};
use super::messages;
use super::names::Worker;
use super::workspace::{own_launch, Lead};
use super::Core;

const MAX_PROMPT_BYTES: usize = 64 * 1024;
const MAX_MODEL_CHARS: usize = 200;
/// How much of a worker's final answer its lead is sent.
const MAX_REPORT_BYTES: usize = 4 * 1024;

/// The window call that opens a terminal agent another agent started.
const OPEN_TERMINAL_METHOD: &str = "agent.terminal";
const OPEN_TERMINAL_WAIT: Duration = Duration::from_secs(30);
/// How long a terminal agent may take to show its prompt box before its lead
/// hears that it has not got its task yet.
const TERMINAL_READY_WAIT: Duration = Duration::from_secs(120);

#[derive(Default)]
pub(crate) struct Spawning {
    /// Spawns one at a time, so two at once cannot both take the last place a
    /// cap leaves.
    one_at_a_time: Mutex<()>,
    /// Terminal agents the window is opening, which count against the caps
    /// before they run.
    opening: Mutex<HashSet<String>>,
    /// Where the turn each terminal worker last reported starts in its session
    /// file. Its screen redrawing after a turn reads as another turn, which
    /// must not report again.
    reported: Mutex<HashMap<String, u64>>,
}

impl Spawning {
    fn one_at_a_time(&self) -> std::sync::MutexGuard<'_, ()> {
        self.one_at_a_time
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn opening(&self) -> std::sync::MutexGuard<'_, HashSet<String>> {
        self.opening
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn reported(&self) -> std::sync::MutexGuard<'_, HashMap<String, u64>> {
        self.reported
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// The agents running here and those the window is opening.
fn running(core: &Core) -> HashSet<String> {
    let mut running = core.running_agents();
    running.extend(core.harness.spawning.opening().iter().cloned());
    running
}

fn text_param<'a>(params: &'a Value, key: &str, max: usize) -> Result<Option<&'a str>, String> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) if !text.trim().is_empty() && text.len() <= max => Ok(Some(text)),
        Some(Value::String(text)) if !text.trim().is_empty() => Err(format!(
            "{key} is {} bytes, more than the {max} it may hold",
            text.len()
        )),
        Some(_) => Err(format!("{key} must be nonempty text")),
    }
}

struct Started {
    agent_id: String,
    name: String,
    provider: String,
    model: Option<String>,
    lead_name: String,
    lead_cli: String,
    reports: bool,
    chat: Arc<chat::Chat>,
}

/// How the calling agent runs and where, for its worker to do the same.
fn lead_of(core: &Core, lead_id: &str, project: &str) -> Result<(Lead, PathBuf), String> {
    let run = core.workspaces.run_of(lead_id);
    if let Some(chat) = core.chats.get(lead_id) {
        let launch = chat.current_now();
        return Ok((
            Lead {
                provider: chat.provider().to_owned(),
                permission_mode: Some(launch.permission_mode.clone()),
                launcher: chat
                    .origin
                    .launcher
                    .clone()
                    .or_else(|| run.map(|run| run.launcher)),
                launch: Some(launch),
            },
            chat.launch.cwd.clone(),
        ));
    }
    let session = core
        .agent_session(lead_id)
        .ok_or("agent_spawn works only for an agent running in Sikemux")?;
    let info = session.info();
    let cwd = info.project.unwrap_or_else(|| project.to_owned());
    Ok((
        Lead {
            provider: info.agent_type.unwrap_or_default(),
            launch: None,
            launcher: run.as_ref().map(|run| run.launcher.clone()),
            permission_mode: run.map(|run| run.permission_mode),
        },
        PathBuf::from(cwd),
    ))
}

fn start(core: &Arc<Core>, request: &HarnessRequest) -> Result<Started, String> {
    let lead_id = request
        .agent_id
        .clone()
        .ok_or("agent_spawn needs the calling agent's id")?;
    let params = &request.params;
    let provider = text_param(params, "cli", 64)?
        .ok_or("cli must name the agent to start, such as claude or codex")?
        .trim()
        .to_lowercase();
    let model = text_param(params, "model", MAX_MODEL_CHARS)?.map(|model| model.trim().to_owned());
    let reports = match params.get("report") {
        None | Some(Value::Null) => true,
        Some(Value::Bool(reports)) => *reports,
        Some(_) => return Err("report must be a boolean".into()),
    };
    let _one_at_a_time = core.harness.spawning.one_at_a_time();
    let (lead, cwd) = lead_of(core, &lead_id, &request.project)?;
    let (mut launch, launcher) = core
        .workspaces
        .worker_launch(&lead, &provider, &cwd, model)?;
    let agent_id = format!("agent-{}", uuid::Uuid::new_v4().simple());
    let named = core.names.hire(
        Worker {
            agent_id: &agent_id,
            lead: &lead_id,
            provider: &provider,
            reports,
        },
        running(core),
    )?;
    own_launch(core, &mut launch, &agent_id);
    let model = launch.model.clone();
    let chat = chat::begin_worker(core, launch, &lead_id, launcher).map_err(|error| {
        core.names.forget(&agent_id);
        error.to_string()
    })?;
    core.broadcast_local(&Event::ChatBegun { chat: chat.info() });
    core.publish_device_view();
    let lead_name = core.names.name(&lead_id).unwrap_or_else(|| lead_id.clone());
    Ok(Started {
        agent_id,
        name: named.name,
        provider,
        model,
        lead_name,
        lead_cli: if lead.provider.is_empty() {
            "agent".to_owned()
        } else {
            lead.provider
        },
        reports,
        chat,
    })
}

pub(crate) async fn spawn(core: &Arc<Core>, request: &HarnessRequest) -> Result<Value, String> {
    let prompt = match request.params.get("prompt") {
        Some(Value::String(prompt)) if !prompt.trim().is_empty() && prompt.len() <= MAX_PROMPT_BYTES => {
            prompt.clone()
        }
        Some(Value::String(prompt)) if !prompt.trim().is_empty() => {
            return Err(format!(
                "prompt is {} bytes; it holds at most {MAX_PROMPT_BYTES}, so put long material in a file and name its path",
                prompt.len()
            ))
        }
        _ => return Err("prompt must be the new agent's task, as nonempty text".into()),
    };
    match request.params.get("mode") {
        None | Some(Value::Null) => {}
        Some(Value::String(mode)) if mode == "chat" => {}
        Some(Value::String(mode)) if mode == "terminal" => {
            return spawn_terminal(core, request, prompt).await
        }
        Some(_) => return Err("mode must be chat or terminal".into()),
    }
    let started = {
        let (core, request) = (core.clone(), request.clone());
        blocking(move || start(&core, &request).map_err(Into::into))
            .await
            .map_err(|error| error.to_string())?
    };
    let reports = started.reports;
    let answer = json!({
        "name": started.name,
        "agentId": started.agent_id,
        "cli": started.provider,
        "model": started.model,
        "reportsBack": reports,
        "note": format!(
            "{} is starting in its own tab and gets your prompt once it is ready.{}",
            started.name,
            if reports { " Each time its turn ends, its final answer comes to you as a message." } else { "" }
        ),
    });
    let core = core.clone();
    tokio::spawn(async move { hand_task(&core, started, prompt).await });
    Ok(answer)
}

/// Gives the new agent its task once it is ready, or tells its lead it
/// never got there.
async fn hand_task(core: &Arc<Core>, started: Started, prompt: String) {
    let Started {
        agent_id,
        name,
        lead_name,
        lead_cli,
        reports,
        chat,
        ..
    } = started;
    let lead_id = chat.origin.started_by.clone().unwrap_or_default();
    let failed = match chat::until_started(core, chat).await {
        Ok(_) => {
            let task = messages::task(&lead_id, &lead_name, &lead_cli, reports, prompt);
            match messages::hand_task(core, &agent_id, task).await {
                Ok(()) => return,
                Err(error) => error,
            }
        }
        Err(error) => error.to_string(),
    };
    messages::report_as(
        core,
        agent_id,
        Some(name.clone()),
        lead_id,
        format!("{name} did not start, so it never got your prompt: {failed}"),
    )
    .await;
}

/// A terminal agent the window is asked to open.
struct Opening {
    agent_id: String,
    name: String,
    provider: String,
    model: Option<String>,
    permission_mode: String,
    launcher: Option<String>,
    lead_id: String,
    lead_name: String,
    lead_cli: String,
    project: String,
    reports: bool,
}

/// Names a terminal worker and says how it runs, for the window to open it.
fn plan_terminal(core: &Core, request: &HarnessRequest) -> Result<Opening, String> {
    let lead_id = request
        .agent_id
        .clone()
        .ok_or("agent_spawn needs the calling agent's id")?;
    let params = &request.params;
    let provider = text_param(params, "cli", 64)?
        .ok_or("cli must name the agent to start, such as claude or codex")?
        .trim()
        .to_lowercase();
    if AgentKind::from_label(&provider).is_none() {
        return Err(format!(
            "{provider} is not an agent Sikemux runs in a terminal"
        ));
    }
    let model = text_param(params, "model", MAX_MODEL_CHARS)?.map(|model| model.trim().to_owned());
    let reports = match params.get("report") {
        None | Some(Value::Null) => true,
        Some(Value::Bool(reports)) => *reports,
        Some(_) => return Err("report must be a boolean".into()),
    };
    if !core.window.is_open() {
        return Err(super::window::not_open("start an agent in a terminal"));
    }
    let _one_at_a_time = core.harness.spawning.one_at_a_time();
    let (lead, _) = lead_of(core, &lead_id, &request.project)?;
    let same = lead.provider == provider;
    let permission_mode = lead.worker_mode(&provider, "workspace-write");
    let model = model.or_else(|| {
        lead.launch
            .as_ref()
            .filter(|_| same)
            .and_then(|launch| launch.model.clone())
    });
    let agent_id = format!("agent-{}", uuid::Uuid::new_v4().simple());
    let named = core.names.hire(
        Worker {
            agent_id: &agent_id,
            lead: &lead_id,
            provider: &provider,
            reports,
        },
        running(core),
    )?;
    core.harness.spawning.opening().insert(agent_id.clone());
    let lead_name = core.names.name(&lead_id).unwrap_or_else(|| lead_id.clone());
    Ok(Opening {
        agent_id,
        name: named.name,
        model,
        permission_mode,
        launcher: lead.launcher.filter(|_| same),
        lead_cli: if lead.provider.is_empty() {
            "agent".to_owned()
        } else {
            lead.provider
        },
        provider,
        lead_id,
        lead_name,
        project: named.project,
        reports,
    })
}

/// Asks the window to open the terminal agent in its lead's project.
async fn open_terminal(core: &Core, opening: &Opening) -> Result<(), String> {
    let request = HarnessRequest {
        id: uuid::Uuid::new_v4().to_string(),
        project: opening.project.clone(),
        agent_id: Some(opening.lead_id.clone()),
        agent_secret: None,
        method: OPEN_TERMINAL_METHOD.to_owned(),
        params: json!({
            "agentId": opening.agent_id,
            "cli": opening.provider,
            "name": opening.name,
            "lead": opening.lead_id,
            "model": opening.model,
            "permissionMode": opening.permission_mode,
            "launcher": opening.launcher,
        }),
    };
    let request = serde_json::to_value(&request).map_err(|error| error.to_string())?;
    let call = core.window.call(
        WindowCall::Harness { request },
        "start an agent in a terminal",
        false,
    )?;
    let id = call.id;
    match tokio::time::timeout(OPEN_TERMINAL_WAIT, call.answer).await {
        Ok(Ok(answer)) => answer.map(|_| ()),
        Ok(Err(_)) => Err("Sikemux's window closed before it opened the terminal".into()),
        Err(_) => {
            core.window.forget(id);
            Err("Sikemux's window did not open the terminal in time".into())
        }
    }
}

async fn spawn_terminal(
    core: &Arc<Core>,
    request: &HarnessRequest,
    prompt: String,
) -> Result<Value, String> {
    let opening = {
        let (core, request) = (core.clone(), request.clone());
        blocking(move || plan_terminal(&core, &request).map_err(Into::into))
            .await
            .map_err(|error| error.to_string())?
    };
    let opened = open_terminal(core, &opening).await;
    core.harness.spawning.opening().remove(&opening.agent_id);
    if let Err(error) = opened {
        core.names.forget(&opening.agent_id);
        return Err(format!("{} did not start: {error}", opening.name));
    }
    let task = messages::task(
        &opening.lead_id,
        &opening.lead_name,
        &opening.lead_cli,
        opening.reports,
        prompt,
    );
    core.harness
        .mailbox
        .returned(&opening.agent_id, task.clone());
    let watcher = core.clone();
    let (agent_id, name, lead_id) = (
        opening.agent_id.clone(),
        opening.name.clone(),
        opening.lead_id.clone(),
    );
    tokio::spawn(async move {
        tokio::time::sleep(TERMINAL_READY_WAIT).await;
        if messages::is_waiting(&watcher, &agent_id, &task)
            && watcher.agent_session(&agent_id).is_some()
        {
            messages::report_as(
                &watcher,
                agent_id,
                Some(name.clone()),
                lead_id,
                format!("{name} has not shown its prompt in its terminal yet, so it has not got your prompt. It may be waiting on the person, such as to trust the folder; it gets your prompt once it is ready."),
            )
            .await;
        }
    });
    Ok(json!({
        "name": opening.name,
        "agentId": opening.agent_id,
        "cli": opening.provider,
        "model": opening.model,
        "mode": "terminal",
        "reportsBack": opening.reports,
        "note": format!(
            "{} is starting in a terminal tab and gets your prompt once its prompt box shows.{}",
            opening.name,
            if opening.reports { " Each time its turn ends, its final answer comes to you as a message." } else { "" }
        ),
    }))
}

/// How a worker's turn, or the worker, came to an end.
pub(crate) enum Ending {
    Finished,
    Stopped,
    Failed(String),
    /// The chat ended, `mid_turn` or while the worker was idle.
    Gone {
        reason: Option<String>,
        mid_turn: bool,
    },
}

/// Sends a worker's lead how the worker's turn ended.
pub(crate) fn turn_ended(core: &Arc<Core>, agent_id: &str, ending: Ending) {
    let ignored = super::board::offer_turn_ignored(core, agent_id);
    let Some(lead) = core.names.reports_to(agent_id) else {
        return;
    };
    if ignored && matches!(ending, Ending::Finished) {
        return;
    }
    let chat_answer = core
        .chats
        .get(agent_id)
        .map(|chat| chat.feed.last_answer().map(TerminalAnswer::Said));
    let (core, worker) = (core.clone(), agent_id.to_owned());
    tokio::spawn(async move {
        let answer = match chat_answer {
            Some(answer) => answer,
            None => {
                let turn = {
                    let (core, worker) = (core.clone(), worker.clone());
                    blocking(move || Ok(follow::terminal_answer(&core, &worker))).await
                };
                let Ok(turn) = turn else { return };
                let mut reported = core.harness.spawning.reported();
                if matches!(ending, Ending::Finished) {
                    if let Some(start) = turn.start {
                        if reported.insert(worker.clone(), start) == Some(start) {
                            return;
                        }
                    }
                } else {
                    reported.remove(&worker);
                }
                drop(reported);
                turn.answer
            }
        };
        let text = report(&core, &worker, ending, answer);
        messages::report(&core, worker, lead, text).await;
    });
}

/// [`turn_ended`] for an agent in a terminal.
pub(crate) fn terminal_turn_ended(core: &Core, agent_id: &str, ending: Ending) {
    if tokio::runtime::Handle::try_current().is_err() {
        return;
    }
    if let Some(core) = core.arc() {
        turn_ended(&core, agent_id, ending);
    }
}

/// What the lead is told about the worker's turn.
fn report(core: &Core, worker: &str, ending: Ending, answer: Option<TerminalAnswer>) -> String {
    let because = |reason: Option<String>| match reason.filter(|reason| !reason.trim().is_empty()) {
        Some(reason) => format!(": {reason}"),
        None => ".".to_owned(),
    };
    let wrote = |answer: TerminalAnswer, heading: &str| match answer {
        TerminalAnswer::Said(said) => format!("{heading}\n\n{}", cut(&said)),
        TerminalAnswer::Screen(screen) => format!(
            "Sikemux cannot read its session, so this is the end of its screen:\n\n{}",
            cut(&screen)
        ),
    };
    let (what, last) = match ending {
        Ending::Finished => match answer {
            Some(answer) => (
                format!("Finished its turn. {}", wrote(answer, "Its final answer:")),
                None,
            ),
            None => (
                "Finished its turn without writing an answer.".to_owned(),
                None,
            ),
        },
        Ending::Stopped => (
            "Was stopped before it finished its turn.".to_owned(),
            answer,
        ),
        Ending::Failed(reason) => (format!("Its turn failed{}", because(Some(reason))), answer),
        Ending::Gone {
            reason,
            mid_turn: true,
        } => (
            format!(
                "Stopped running before it finished its turn{}",
                because(reason)
            ),
            answer,
        ),
        Ending::Gone {
            reason,
            mid_turn: false,
        } => (format!("Stopped running{}", because(reason)), None),
    };
    let mut text = match last {
        Some(last) => format!("{what}\n\n{}", wrote(last, "What it wrote last:")),
        None => what,
    };
    if let Some(card) = super::board::card_line(core, worker) {
        text.push_str(&format!("\n\n{card}"));
    }
    text
}

fn cut(answer: &str) -> String {
    if answer.len() <= MAX_REPORT_BYTES {
        return answer.to_owned();
    }
    let mut end = MAX_REPORT_BYTES;
    while !answer.is_char_boundary(end) {
        end -= 1;
    }
    format!(
        "{}\n\n[Cut to its first {} KB; ask it for the rest.]",
        answer[..end].trim_end(),
        MAX_REPORT_BYTES / 1024
    )
}

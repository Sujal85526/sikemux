//! What `agent_spawn` answers: an agent starting another as a full chat of
//! its own, on its account and in its permission mode, which the app shows in
//! a tab without moving the person there. Each time the new agent's turn ends,
//! its final answer goes back to the agent that started it.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use crate::cli::protocol::HarnessRequest;
use crate::protocol::Event;

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

/// Spawns one at a time, so two at once cannot both take the last place a
/// cap leaves.
#[derive(Default)]
pub(crate) struct Spawning(Mutex<()>);

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
    let _one_at_a_time = core
        .harness
        .spawning
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
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
        core.running_agents(),
    )?;
    own_launch(core, &mut launch, &agent_id);
    let model = launch.model.clone();
    let chat =
        chat::begin_worker(core, launch, &lead_id, launcher).map_err(|error| error.to_string())?;
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
                let (core, worker) = (core.clone(), worker.clone());
                blocking(move || Ok(follow::terminal_answer(&core, &worker)))
                    .await
                    .ok()
                    .flatten()
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

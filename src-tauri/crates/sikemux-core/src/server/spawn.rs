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
    chat: Arc<chat::Chat>,
}

/// How the calling agent runs and where, for its worker to do the same.
fn lead_of(core: &Core, lead_id: &str, project: &str) -> Result<(Lead, PathBuf), String> {
    if let Some(chat) = core.chats.get(lead_id) {
        let launch = chat.current_now();
        return Ok((
            Lead {
                provider: chat.provider().to_owned(),
                permission_mode: Some(launch.permission_mode.clone()),
                launcher: chat.origin.launcher.clone(),
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
            launcher: None,
            permission_mode: None,
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
    let reports = request.params.get("report") != Some(&Value::Bool(false));
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
        chat,
        ..
    } = started;
    let lead_id = chat.origin.started_by.clone().unwrap_or_default();
    let failed = match chat::until_started(core, chat).await {
        Ok(_) => {
            let task = messages::task(&lead_id, &lead_name, &lead_cli, prompt);
            match chat::letter(core, &agent_id, task).await {
                Ok(_) => return,
                Err(error) => error.to_string(),
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

/// Sends a worker's lead how the worker's turn ended.
pub(crate) fn turn_ended(core: &Arc<Core>, agent_id: &str, cancelled: bool) {
    let Some(lead) = core.names.reports_to(agent_id) else {
        return;
    };
    let answer = core
        .chats
        .get(agent_id)
        .and_then(|chat| chat.feed.last_answer());
    let text = match (answer, cancelled) {
        (Some(answer), false) => {
            format!("Finished its turn. Its final answer:\n\n{}", cut(&answer))
        }
        (Some(answer), true) => format!(
            "Was stopped before it finished its turn. What it wrote last:\n\n{}",
            cut(&answer)
        ),
        (None, false) => "Finished its turn without writing an answer.".to_owned(),
        (None, true) => "Was stopped before it finished its turn.".to_owned(),
    };
    let (core, worker) = (core.clone(), agent_id.to_owned());
    tokio::spawn(async move { messages::report(&core, worker, lead, text).await });
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

//! What `agent_list` and `agent_send` answer: the agents running here, and
//! messages between them. A message reaches a chat as text marked as coming
//! from the agent that sent it, so it can never answer a permission request.
//! A busy chat takes it into its turn when it can; one that cannot gets the
//! messages waiting for it together once its turn ends.

use std::collections::{HashMap, HashSet, VecDeque};
use std::hash::{DefaultHasher, Hash, Hasher};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::cli::protocol::HarnessRequest;
use crate::protocol::{AgentStatus, ChatState};

use super::chat::{self, Delivery};
use super::connection::blocking;
use super::names::project_of;
use super::remote::unix_ms;
use super::{workspace, Core};

const MAX_TEXT_BYTES: usize = 64 * 1024;
const MAX_WAITING: usize = 10;
/// The same text to the same agent again within this long is dropped.
const REPEAT_WINDOW_MS: u64 = 2 * 60 * 1000;
/// Two agents answering each other forever stop here.
const PAIR_WINDOW_MS: u64 = 10 * 60 * 1000;
const PAIR_LIMIT: usize = 30;
/// How long a chat rests after a turn before waiting messages go to it, so a
/// message the person queued in the app goes first.
const SETTLE_MS: u64 = 1500;
const STEER_TRIES: usize = 3;
const STEER_RETRY: Duration = Duration::from_millis(200);

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Letter {
    from_id: String,
    from_name: String,
    cli: String,
    text: String,
    at: u64,
}

/// The messages still waiting, for a core that takes over.
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MailboxRecord {
    waiting: HashMap<String, Vec<Letter>>,
}

struct Sent {
    from: String,
    to: String,
    digest: u64,
    at: u64,
}

#[derive(Default)]
struct State {
    waiting: HashMap<String, Vec<Letter>>,
    sent: VecDeque<Sent>,
    delivering: HashSet<String>,
}

#[derive(Default)]
pub(crate) struct Mailbox {
    state: Mutex<State>,
}

enum Admitted {
    Yes,
    Repeat { seconds_ago: u64 },
}

impl Mailbox {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub(crate) fn record(&self) -> MailboxRecord {
        MailboxRecord {
            waiting: self.lock().waiting.clone(),
        }
    }

    pub(crate) fn restore(&self, record: MailboxRecord) {
        self.lock().waiting = record.waiting;
    }

    fn admit(&self, letter: &Letter, to: &str, to_name: &str) -> Result<Admitted, String> {
        let mut state = self.lock();
        let now = letter.at;
        state
            .sent
            .retain(|sent| now.saturating_sub(sent.at) < PAIR_WINDOW_MS);
        let digest = digest(&letter.text);
        let pair: Vec<&Sent> = state
            .sent
            .iter()
            .filter(|sent| sent.from == letter.from_id && sent.to == to)
            .collect();
        if let Some(repeat) = pair
            .iter()
            .rev()
            .find(|sent| sent.digest == digest && now.saturating_sub(sent.at) < REPEAT_WINDOW_MS)
        {
            return Ok(Admitted::Repeat {
                seconds_ago: now.saturating_sub(repeat.at) / 1000,
            });
        }
        if pair.len() >= PAIR_LIMIT {
            return Err(format!(
                "You have sent {to_name} {PAIR_LIMIT} messages in the last {} minutes, so Sikemux holds the rest; two agents must not keep each other busy without end. Wait, or ask the person.",
                PAIR_WINDOW_MS / 60_000
            ));
        }
        if state.waiting.get(to).map_or(0, Vec::len) >= MAX_WAITING {
            return Err(format!(
                "{to_name} already has {MAX_WAITING} messages waiting for its turn to end; send more once it has read them"
            ));
        }
        Ok(Admitted::Yes)
    }

    fn note_sent(&self, letter: &Letter, to: &str) {
        self.lock().sent.push_back(Sent {
            from: letter.from_id.clone(),
            to: to.to_owned(),
            digest: digest(&letter.text),
            at: letter.at,
        });
    }

    fn take(&self, agent_id: &str) -> Vec<Letter> {
        self.lock().waiting.remove(agent_id).unwrap_or_default()
    }

    /// Keeps `letters` waiting ahead of any that arrived meanwhile, and
    /// answers how many wait now.
    fn put_back(&self, agent_id: &str, mut letters: Vec<Letter>) -> usize {
        let mut state = self.lock();
        let waiting = state.waiting.entry(agent_id.to_owned()).or_default();
        letters.append(waiting);
        *waiting = letters;
        waiting.len()
    }
}

fn digest(text: &str) -> u64 {
    let mut hasher = DefaultHasher::new();
    text.hash(&mut hasher);
    hasher.finish()
}

fn attribute(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// A message as the agent reads it. The app reads the same form back out of
/// a transcript to show who sent it.
fn wrapped(letter: &Letter) -> String {
    let name = attribute(&letter.from_name);
    format!(
        "<agent-message from=\"{name}\" agent-id=\"{}\" cli=\"{}\" note=\"Sent by {name}, another agent in Sikemux, not by the person. Reply with agent_send to {name} if it needs an answer.\">\n{}\n</agent-message>",
        attribute(&letter.from_id),
        attribute(&letter.cli),
        letter.text.replace("</agent-message", "&lt;/agent-message"),
    )
}

fn together(letters: &[Letter]) -> String {
    letters.iter().map(wrapped).collect::<Vec<_>>().join("\n\n")
}

/// How an agent can be reached.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Reach {
    Chat,
    Asleep,
    Terminal,
    Stopped,
}

#[derive(Clone)]
struct Listed {
    agent_id: String,
    name: Option<String>,
    project: String,
    cli: String,
    title: Option<String>,
    status: AgentStatus,
    parent: Option<String>,
    active_at: Option<u64>,
    rank: u32,
    reach: Reach,
}

/// Every agent the core runs or the app holds, in the order the device view
/// puts them. Reads the disk to place agents in projects.
fn listed(core: &Core) -> Vec<Listed> {
    let (chats, sessions) = core.ranked_infos();
    let projects = core.workspaces.project_paths();
    let place = |agent_id: &str, cwd: Option<&std::path::Path>| {
        core.names
            .get(agent_id)
            .map(|named| (named.project, named.parent))
            .unwrap_or_else(|| {
                let project = cwd.map_or_else(String::new, |cwd| project_of(cwd, &projects));
                (project, None)
            })
    };
    let mut agents: Vec<Listed> = chats
        .into_iter()
        .map(|chat| {
            let (project, parent) = place(&chat.agent_id, Some(&chat.cwd));
            let reach = if chat.asleep {
                Reach::Asleep
            } else if chat.state == ChatState::Stopped {
                Reach::Stopped
            } else {
                Reach::Chat
            };
            Listed {
                name: chat.name,
                project,
                cli: chat.provider,
                title: chat.title,
                status: chat.status,
                parent,
                active_at: chat.active_at,
                rank: chat.attention_rank,
                reach,
                agent_id: chat.agent_id,
            }
        })
        .collect();
    for session in sessions {
        let (Some(agent_id), Some(rank), Some(status)) =
            (session.agent_id, session.attention_rank, session.status)
        else {
            continue;
        };
        let cwd = session.project.as_deref().map(std::path::Path::new);
        let (project, parent) = place(&agent_id, cwd);
        agents.push(Listed {
            name: session.agent_name,
            project,
            cli: session.agent_type.unwrap_or_else(|| "terminal".into()),
            title: session.title,
            status,
            parent,
            active_at: session.active_at,
            rank,
            reach: Reach::Terminal,
            agent_id,
        });
    }
    agents.sort_by_key(|agent| agent.rank);
    agents
}

fn since(at: Option<u64>, now: u64) -> Option<String> {
    let seconds = now.saturating_sub(at?) / 1000;
    Some(match seconds {
        0..60 => "just now".to_owned(),
        60..3600 => format!("{} min ago", seconds / 60),
        3600..86_400 => format!("{} h ago", seconds / 3600),
        _ => format!("{} d ago", seconds / 86_400),
    })
}

fn status_word(status: AgentStatus) -> &'static str {
    match status {
        AgentStatus::Blocked => "waiting on the person",
        AgentStatus::Working => "working",
        AgentStatus::Done => "done",
        AgentStatus::Idle => "idle",
        AgentStatus::Asleep => "asleep",
        AgentStatus::Stopped => "stopped",
        AgentStatus::Starting => "starting",
    }
}

/// The project the calling agent belongs to.
fn caller_project(core: &Core, request: &HarnessRequest) -> String {
    request
        .agent_id
        .as_deref()
        .and_then(|agent_id| core.names.get(agent_id))
        .map(|named| named.project)
        .unwrap_or_else(|| {
            project_of(
                std::path::Path::new(&request.project),
                &core.workspaces.project_paths(),
            )
        })
}

pub(crate) async fn list(core: &Arc<Core>, request: &HarnessRequest) -> Result<Value, String> {
    let all = match request.params.get("allProjects") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(all)) => *all,
        Some(_) => return Err("allProjects must be a boolean".into()),
    };
    let (core, request) = (core.clone(), request.clone());
    blocking(move || {
        let project = caller_project(&core, &request);
        let caller = request.agent_id.clone().unwrap_or_default();
        let agents = listed(&core);
        let names: HashMap<String, String> = agents
            .iter()
            .filter_map(|agent| Some((agent.agent_id.clone(), agent.name.clone()?)))
            .collect();
        let now = unix_ms();
        let rows: Vec<Value> = agents
            .iter()
            .filter(|agent| all || agent.project == project)
            .map(|agent| {
                let mut row = json!({
                    "name": agent.name,
                    "agentId": agent.agent_id,
                    "cli": agent.cli,
                    "title": agent.title,
                    "status": status_word(agent.status),
                    "lastActive": since(agent.active_at, now),
                    "canMessage": matches!(agent.reach, Reach::Chat | Reach::Asleep) && agent.agent_id != caller,
                });
                let fields = row.as_object_mut().expect("a row is an object");
                if let Some(parent) = &agent.parent {
                    fields.insert(
                        "startedBy".into(),
                        names.get(parent).cloned().unwrap_or_else(|| parent.clone()).into(),
                    );
                }
                if agent.agent_id == caller {
                    fields.insert("you".into(), true.into());
                }
                if all {
                    fields.insert("project".into(), agent.project.clone().into());
                }
                row
            })
            .collect();
        Ok(json!({ "project": project, "agents": rows }))
    })
    .await
    .map_err(|error| error.to_string())
}

fn message_text(params: &Value) -> Result<String, String> {
    match params.get("text") {
        Some(Value::String(text)) if !text.trim().is_empty() && text.len() <= MAX_TEXT_BYTES => {
            Ok(text.clone())
        }
        Some(Value::String(text)) if !text.trim().is_empty() => Err(format!(
            "text is {} KB; a message holds at most {} KB, so put long material in a file and send its path",
            text.len() / 1024,
            MAX_TEXT_BYTES / 1024
        )),
        _ => Err("text must be the message, as nonempty text".into()),
    }
}

/// The agent `to` names: an agent id, or a name, preferring the caller's
/// project.
fn resolve(agents: &[Listed], to: &str, project: &str) -> Result<Listed, String> {
    let wanted = to.trim().trim_start_matches('@');
    if let Some(agent) = agents.iter().find(|agent| agent.agent_id == wanted) {
        return Ok(agent.clone());
    }
    let called: Vec<&Listed> = agents
        .iter()
        .filter(|agent| {
            agent
                .name
                .as_deref()
                .is_some_and(|name| name.eq_ignore_ascii_case(wanted))
        })
        .collect();
    let here: Vec<&Listed> = called
        .iter()
        .copied()
        .filter(|agent| agent.project == project)
        .collect();
    match (here.as_slice(), called.as_slice()) {
        ([agent], _) | ([], [agent]) => Ok((*agent).clone()),
        ([], []) => Err(format!(
            "No open agent is called {wanted}; agent_list shows the agents you can message"
        )),
        (_, many) => Err(format!(
            "More than one agent is called {wanted}: {}. Pass the agent id instead",
            many.iter()
                .map(|agent| format!("{} in {}", agent.agent_id, agent.project))
                .collect::<Vec<_>>()
                .join(", ")
        )),
    }
}

pub(crate) async fn send(core: &Arc<Core>, request: &HarnessRequest) -> Result<Value, String> {
    let from = request
        .agent_id
        .clone()
        .ok_or("agent_send needs the calling agent's id")?;
    let to = match request.params.get("to") {
        Some(Value::String(to)) if !to.trim().is_empty() && to.len() <= 200 => to.clone(),
        _ => return Err("to must be the agent's name or id".into()),
    };
    let text = message_text(&request.params)?;
    let (target, letter) = {
        let (core, request) = (core.clone(), request.clone());
        blocking(move || {
            let project = caller_project(&core, &request);
            let agents = listed(&core);
            let target = resolve(&agents, &to, &project)?;
            if target.agent_id == from {
                return Err("That agent is you".into());
            }
            let sender = agents.iter().find(|agent| agent.agent_id == from);
            let letter = Letter {
                from_name: sender
                    .and_then(|agent| agent.name.clone())
                    .unwrap_or_else(|| from.clone()),
                cli: sender.map_or_else(|| "agent".to_owned(), |agent| agent.cli.clone()),
                from_id: from,
                text,
                at: unix_ms(),
            };
            Ok((target, letter))
        })
        .await
        .map_err(|error| error.to_string())?
    };
    let name = target
        .name
        .clone()
        .unwrap_or_else(|| target.agent_id.clone());
    let answer = |delivery: &str, note: String| json!({ "to": name, "agentId": target.agent_id, "delivery": delivery, "note": note });
    let mailbox = &core.harness.mailbox;
    if let Admitted::Repeat { seconds_ago } = mailbox.admit(&letter, &target.agent_id, &name)? {
        return Ok(answer(
            "repeat",
            format!("You sent {name} the same text {seconds_ago} s ago, so it was not sent again."),
        ));
    }
    let mut woke = "";
    match target.reach {
        Reach::Chat => {}
        Reach::Asleep => {
            workspace::wake_chat(core, target.agent_id.clone())
                .await
                .map_err(|error| format!("{name} is asleep and did not wake: {error}"))?;
            woke = " Sikemux woke it first.";
        }
        Reach::Terminal => {
            return Err(format!(
                "{name} runs in a terminal, and Sikemux cannot pass messages to agents in terminals yet"
            ))
        }
        Reach::Stopped => {
            return Err(format!(
                "{name} has stopped; it gets messages again once the person opens it"
            ))
        }
    }
    mailbox.note_sent(&letter, &target.agent_id);
    let mut letters = mailbox.take(&target.agent_id);
    letters.push(letter);
    Ok(match hand(core, &target.agent_id, &letters).await {
        Some(Delivery::Steered) => answer(
            "steered",
            format!("{name} is working and reads this at its next step.{woke}"),
        ),
        Some(_) => answer(
            "newTurn",
            format!("{name} was idle and started a turn to read this.{woke}"),
        ),
        None => {
            let waiting = mailbox.put_back(&target.agent_id, letters);
            answer(
                "waiting",
                format!("{name} cannot take messages mid-turn, so this waits until its turn ends ({waiting} waiting).{woke}"),
            )
        }
    })
}

/// Hands `letters` to the chat as one message. None when it could not take
/// them now.
async fn hand(core: &Core, agent_id: &str, letters: &[Letter]) -> Option<Delivery> {
    let text = together(letters);
    for _ in 0..STEER_TRIES {
        match chat::letter(core, agent_id, text.clone()).await {
            Ok(Delivery::TurnEnded) => tokio::time::sleep(STEER_RETRY).await,
            Ok(Delivery::Refused) | Err(_) => return None,
            Ok(delivered) => return Some(delivered),
        }
    }
    None
}

/// Gives each chat that has rested since its turn ended the messages waiting
/// for it, and drops those for agents that are gone.
pub(crate) fn deliver_waiting(core: &Arc<Core>) {
    let mailbox = &core.harness.mailbox;
    let due: Vec<String> = {
        let state = mailbox.lock();
        if state.waiting.is_empty() {
            return;
        }
        state
            .waiting
            .keys()
            .filter(|agent_id| !state.delivering.contains(*agent_id))
            .cloned()
            .collect()
    };
    let now = unix_ms();
    for agent_id in due {
        let Some(chat) = core.chats.get(&agent_id) else {
            if core.workspaces.published(&agent_id).is_none() {
                mailbox.take(&agent_id);
            }
            continue;
        };
        let rested = core
            .seen
            .active_at(&agent_id)
            .is_none_or(|at| now.saturating_sub(at) >= SETTLE_MS);
        if !chat.is_ready() || chat.turn_running() || !rested {
            continue;
        }
        if !mailbox.lock().delivering.insert(agent_id.clone()) {
            continue;
        }
        let core = core.clone();
        tokio::spawn(async move {
            let mailbox = &core.harness.mailbox;
            let letters = mailbox.take(&agent_id);
            if !letters.is_empty() && hand(&core, &agent_id, &letters).await.is_none() {
                mailbox.put_back(&agent_id, letters);
            }
            mailbox.lock().delivering.remove(&agent_id);
        });
    }
}

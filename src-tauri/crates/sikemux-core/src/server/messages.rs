//! What `agent_list` and `agent_send` answer: the agents running here, and
//! messages between them. A message reaches an agent as text marked as coming
//! from the agent that sent it, so it can never answer a permission request.
//! A busy chat takes it into its turn when it can; an agent that cannot gets
//! the messages waiting for it together once its turn ends.

use std::collections::{HashMap, HashSet, VecDeque};
use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::cli::protocol::HarnessRequest;
use crate::protocol::{AgentStatus, ChatState};

use self::log::{Entry, MessageLog, Outcome};
use super::chat::{self, Delivery};
use super::connection::blocking;
use super::kept::Kept;
use super::names::project_of;
use super::remote::unix_ms;
use super::session::{self, Session};
use super::{agent, workspace, Core};

mod log;

const FILE: &str = "agent-mailbox.json";
const MAX_TEXT_BYTES: usize = 64 * 1024;
const MAX_WAITING: usize = 10;
const BOARD: &str = "board";
/// The same text to the same agent again within this long is dropped.
const REPEAT_WINDOW_MS: u64 = 2 * 60 * 1000;
/// Two agents answering each other forever stop here.
const PAIR_WINDOW_MS: u64 = 10 * 60 * 1000;
const PAIR_LIMIT: usize = 30;
/// How long an agent rests after a turn before a message starts another, so a
/// message the person queued in the app goes first.
const SETTLE_MS: u64 = 1500;
/// How long after waking an asleep chat failed before it is tried again.
const WAKE_RETRY_MS: u64 = 60_000;
/// A terminal agent takes the Enter that sends a pasted message only once it
/// has taken in the paste.
const ENTER_AFTER_PASTE: Duration = Duration::from_millis(150);
/// A terminal agent that keeps printing this long after the Enter that sends
/// a paste has started a turn on it.
const TURN_OUTPUT_MS: u64 = 1000;
/// Pastes a terminal agent may leave untaken in a row before Sikemux stops
/// typing into it until it starts a turn of its own.
const MAX_MISSED_PASTES: u8 = 3;

/// What a message between agents is.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Kind {
    Message,
    /// How a worker's turn ended, sent to its lead.
    Report,
    Question,
    Answer,
}

struct Letter {
    kind: Kind,
    from_id: String,
    from_name: String,
    cli: String,
    text: String,
    at: u64,
    /// What the agent reading it is told about it, when not the usual.
    note: Option<String>,
    /// The question this answers, when the person answered one.
    answers: Option<Answered>,
}

/// A question the person answered, and the agent that asked it.
pub(crate) struct Answered {
    pub question: String,
    pub asker: String,
    pub cli: String,
}

/// The messages still waiting, as each agent reads them, kept in the data
/// folder.
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MailboxRecord {
    waiting: HashMap<String, Vec<Queued>>,
}

/// Who sent a message and what it is.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Origin {
    from: String,
    kind: Kind,
}

/// A message waiting for its agent, as the agent reads it.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Queued {
    text: String,
    /// Unknown for a message that came back unread.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    origin: Option<Origin>,
}

fn joined(queued: &[Queued]) -> String {
    queued
        .iter()
        .map(|queued| queued.text.as_str())
        .collect::<Vec<_>>()
        .join("\n\n")
}

struct Sent {
    from: String,
    to: String,
    digest: u64,
    at: u64,
}

/// Messages typed into a terminal agent's prompt that it has not yet been
/// seen to take.
struct Pasted {
    texts: Vec<Queued>,
    /// When Enter was sent, once it was.
    entered_at: Option<u64>,
}

#[derive(Default)]
struct State {
    waiting: HashMap<String, Vec<Queued>>,
    sent: VecDeque<Sent>,
    delivering: HashSet<String>,
    wake_failed: HashMap<String, u64>,
    pasted: HashMap<String, Pasted>,
    /// How many pastes in a row each terminal agent did not take.
    missed_pastes: HashMap<String, u8>,
}

impl State {
    /// What is kept: a paste not yet taken waits ahead of the rest.
    fn record(&self) -> MailboxRecord {
        let mut waiting = self.waiting.clone();
        for (agent_id, pasted) in &self.pasted {
            let queued = waiting.entry(agent_id.clone()).or_default();
            let mut texts = pasted.texts.clone();
            texts.append(queued);
            *queued = texts;
        }
        MailboxRecord { waiting }
    }
}

pub(crate) struct Mailbox {
    state: Mutex<State>,
    kept: Kept,
    pub(crate) log: MessageLog,
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

    /// Takes up the messages left waiting for agents `known` says still
    /// exist.
    pub(crate) fn new(data_dir: Option<&Path>, known: impl Fn(&str) -> bool) -> Self {
        let kept = Kept::new(data_dir, FILE);
        let mut record: MailboxRecord = kept.load();
        record.waiting.retain(|agent_id, _| known(agent_id));
        Self {
            state: Mutex::new(State {
                waiting: record.waiting,
                ..State::default()
            }),
            kept,
            log: MessageLog::new(data_dir),
        }
    }

    /// Changes the messages waiting, and keeps what they are now.
    fn change<R>(&self, change: impl FnOnce(&mut State) -> R) -> R {
        let mut state = self.lock();
        let changed = change(&mut state);
        state.waiting.retain(|_, waiting| !waiting.is_empty());
        self.kept.save(&state.record());
        changed
    }

    fn admit(&self, letter: &Letter, to: &str, to_name: &str) -> Result<Admitted, String> {
        let mut state = self.lock();
        let now = letter.at;
        state
            .sent
            .retain(|sent| now.saturating_sub(sent.at) < PAIR_WINDOW_MS);
        let digest = digest(&wrapped(letter));
        let pair: Vec<&Sent> = state
            .sent
            .iter()
            .filter(|sent| sent.from == letter.from_id && sent.to == to)
            .collect();
        let repeat = pair
            .iter()
            .rev()
            .find(|sent| sent.digest == digest && now.saturating_sub(sent.at) < REPEAT_WINDOW_MS);
        // Answers, reports and questions each stand for an event of their own,
        // however alike they read, and so does a board note.
        if let Some(repeat) =
            repeat.filter(|_| letter.kind == Kind::Message && letter.from_id != BOARD)
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
            digest: digest(&wrapped(letter)),
            at: letter.at,
        });
    }

    pub(crate) fn has_waiting(&self, agent_id: &str) -> bool {
        self.lock().waiting.contains_key(agent_id)
    }

    fn missed_pastes(&self, agent_id: &str) -> u8 {
        self.lock()
            .missed_pastes
            .get(agent_id)
            .copied()
            .unwrap_or_default()
    }

    /// Answers how many wait now.
    fn wait(&self, agent_id: &str, queued: Queued) -> usize {
        self.change(|state| {
            let waiting = state.waiting.entry(agent_id.to_owned()).or_default();
            waiting.push(queued);
            waiting.len()
        })
    }

    fn take(&self, agent_id: &str) -> Vec<Queued> {
        if !self.has_waiting(agent_id) {
            return Vec::new();
        }
        self.change(|state| state.waiting.remove(agent_id).unwrap_or_default())
    }

    /// Keeps `texts` waiting ahead of any that arrived meanwhile.
    fn put_back(&self, agent_id: &str, texts: Vec<Queued>) {
        self.change(|state| put_back(state, agent_id, texts));
    }

    /// A message the agent was handed but dropped unread waits for its next
    /// turn, ahead of the rest.
    pub(crate) fn returned(&self, agent_id: &str, text: String) {
        self.put_back(agent_id, vec![Queued { text, origin: None }]);
    }
}

fn put_back(state: &mut State, agent_id: &str, mut texts: Vec<Queued>) {
    let waiting = state.waiting.entry(agent_id.to_owned()).or_default();
    texts.append(waiting);
    *waiting = texts;
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
    if let Some(answered) = &letter.answers {
        return format!(
            "<question-answer asker=\"{}\" cli=\"{}\" question=\"{}\" note=\"{}\">\n{}\n</question-answer>",
            attribute(&answered.asker),
            attribute(&answered.cli),
            attribute(&answered.question),
            attribute(letter.note.as_deref().unwrap_or_default()),
            letter
                .text
                .replace("</question-answer", "&lt;/question-answer"),
        );
    }
    let name = &letter.from_name;
    let note = letter.note.clone().unwrap_or_else(|| {
        format!("Sent by {name}, another agent in Sikemux, not by the person. Reply with agent_send to {name} if it needs an answer.")
    });
    format!(
        "<agent-message from=\"{}\" agent-id=\"{}\" cli=\"{}\" note=\"{}\">\n{}\n</agent-message>",
        attribute(name),
        attribute(&letter.from_id),
        attribute(&letter.cli),
        attribute(&note),
        letter.text.replace("</agent-message", "&lt;/agent-message"),
    )
}

/// The task a lead gives an agent it started, as that agent reads it.
pub(crate) fn task(
    lead_id: &str,
    lead_name: &str,
    lead_cli: &str,
    reports: bool,
    text: String,
) -> String {
    let answer = if reports {
        format!("When your turn ends, your final answer goes to {lead_name} by itself. Message {lead_name} with agent_send if you need to ask it something first.")
    } else {
        format!("Your answers do not go to {lead_name} by themselves: send {lead_name} what it needs with agent_send when you are done.")
    };
    wrapped(&Letter {
        kind: Kind::Message,
        from_id: lead_id.to_owned(),
        from_name: lead_name.to_owned(),
        cli: lead_cli.to_owned(),
        text,
        at: unix_ms(),
        answers: None,
        note: Some(format!(
            "{lead_name}, another agent in Sikemux, started you to do this; it is your lead, not the person. {answer}"
        )),
    })
}

/// Hands a new agent its task: into a turn, or ahead of whatever waits for
/// it when it is already busy with something else.
pub(crate) async fn hand_task(
    core: &Arc<Core>,
    agent_id: &str,
    task: String,
) -> Result<(), String> {
    let mailbox = &core.harness.mailbox;
    let origin = core
        .names
        .get(agent_id)
        .and_then(|named| named.parent)
        .map(|lead| Origin {
            from: lead,
            kind: Kind::Message,
        });
    let queued = Queued {
        text: task.clone(),
        origin,
    };
    if mailbox.has_waiting(agent_id) {
        log(core, agent_id, [&queued], Outcome::Waiting);
        mailbox.put_back(agent_id, vec![queued]);
        return Ok(());
    }
    match chat::letter(core, agent_id, task).await {
        Ok(delivered @ (Delivery::Steered | Delivery::NewTurn)) => {
            let outcome = match delivered {
                Delivery::Steered => Outcome::Steered,
                _ => Outcome::NewTurn,
            };
            log(core, agent_id, [&queued], outcome);
            Ok(())
        }
        Ok(Delivery::TurnEnded | Delivery::Refused) => {
            log(core, agent_id, [&queued], Outcome::Waiting);
            mailbox.put_back(agent_id, vec![queued]);
            Ok(())
        }
        Err(error) => Err(error.to_string()),
    }
}

/// The latest messages between agents in `project`, newest first.
pub(crate) fn logged(core: &Core, project: &str, limit: Option<usize>) -> Vec<Entry> {
    let limit = limit.unwrap_or(log::MAX_READ).min(log::MAX_READ);
    core.harness.mailbox.log.read(project, limit)
}

/// Notes in the log of the project of agent `to` what became of messages
/// for it.
fn log<'a>(core: &Core, to: &str, queued: impl IntoIterator<Item = &'a Queued>, outcome: Outcome) {
    let Some(project) = core.names.get(to).map(|named| named.project) else {
        return;
    };
    let at = unix_ms();
    for queued in queued {
        core.harness.mailbox.log.append(
            &project,
            &Entry {
                at,
                from: queued.origin.as_ref().map(|origin| origin.from.clone()),
                kind: queued.origin.as_ref().map(|origin| origin.kind),
                to: to.to_owned(),
                outcome,
            },
        );
    }
}

/// How an agent can be reached.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Reach {
    Chat,
    Asleep,
    Terminal,
    Stopped,
}

#[derive(Clone)]
pub(crate) struct Listed {
    pub agent_id: String,
    pub name: Option<String>,
    pub project: String,
    pub cli: String,
    title: Option<String>,
    pub status: AgentStatus,
    parent: Option<String>,
    active_at: Option<u64>,
    rank: u32,
    pub reach: Reach,
}

impl Listed {
    /// Its status, with an agent at rest that has a task or messages waiting
    /// for it counted as about to start its next turn.
    pub(crate) fn standing(&self, core: &Core) -> AgentStatus {
        let resting = matches!(
            self.status,
            AgentStatus::Idle | AgentStatus::Done | AgentStatus::Asleep
        );
        if resting && core.harness.mailbox.has_waiting(&self.agent_id) {
            AgentStatus::Starting
        } else {
            self.status
        }
    }
}

/// Every agent the core runs or the app holds, in the order the device view
/// puts them. Reads the disk to place agents in projects.
pub(crate) fn listed(core: &Core) -> Vec<Listed> {
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

pub(crate) fn status_word(status: AgentStatus) -> &'static str {
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
pub(crate) fn caller_project(core: &Core, request: &HarnessRequest) -> String {
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
                    "status": status_word(agent.standing(&core)),
                    "lastActive": since(agent.active_at, now),
                    "canMessage": agent.reach != Reach::Stopped && agent.agent_id != caller,
                });
                let fields = row.as_object_mut().expect("a row is an object");
                if let Some(parent) = &agent.parent {
                    fields.insert(
                        "startedBy".into(),
                        names
                            .get(parent)
                            .cloned()
                            .unwrap_or_else(|| parent.clone())
                            .into(),
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
            "text is {} bytes; a message holds at most {MAX_TEXT_BYTES}, so put long material in a file and send its path",
            text.len(),
        )),
        _ => Err("text must be the message, as nonempty text".into()),
    }
}

/// The agent `to` names: an agent id, or a name, preferring the caller's
/// project.
pub(crate) fn resolve(
    agents: &[Listed],
    to: &str,
    project: &str,
    caller: &str,
) -> Result<Listed, String> {
    let wanted = to.trim().trim_start_matches('@');
    if let Some(agent) = agents.iter().find(|agent| agent.agent_id == wanted) {
        return Ok(agent.clone());
    }
    let named = |agent: &&Listed| {
        agent
            .name
            .as_deref()
            .is_some_and(|name| name.eq_ignore_ascii_case(wanted))
    };
    let (yours, called): (Vec<&Listed>, Vec<&Listed>) = agents
        .iter()
        .filter(named)
        .partition(|agent| agent.agent_id == caller);
    if called.is_empty() && !yours.is_empty() {
        return Err("That agent is you".into());
    }
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
    let answers = match request.params.get("answers") {
        None | Some(Value::Null) => None,
        Some(Value::String(id)) if !id.trim().is_empty() => Some(id.trim().to_owned()),
        Some(_) => return Err("answers must be the id of the question this answers".into()),
    };
    let (target, letter) = {
        let (core, request, answers) = (core.clone(), request.clone(), answers.clone());
        blocking(move || {
            let project = caller_project(&core, &request);
            let agents = listed(&core);
            let target = resolve(&agents, &to, &project, &from)?;
            if target.agent_id == from {
                return Err("That agent is you".into());
            }
            let mut letter = letter_from(&agents, Kind::Message, from, text, None);
            if let Some(id) = &answers {
                let name = target.name.as_deref().unwrap_or(&target.agent_id);
                let asked = core
                    .harness
                    .questions
                    .asked_of(&letter.from_id, &target.agent_id, id)
                    .ok_or_else(|| format!("{name} has no open question {id} that it asked you; it was answered already, or leave out answers to send this as a plain message"))?;
                letter.kind = Kind::Answer;
                letter.note = Some(format!(
                    "Sent by {}, your lead in Sikemux, not by the person, answering the question you asked: {asked}",
                    letter.from_name
                ));
            }
            Ok((target, letter))
        })
        .await
        .map_err(|error| error.to_string())?
    };
    let from = letter.from_id.clone();
    let sent = deliver(core, &target, letter).await?;
    if let Some(id) = answers {
        core.harness
            .questions
            .lead_answered(&from, &target.agent_id, &id);
    }
    Ok(sent)
}

/// Puts the question `text` from one agent to its lead, with `note` in
/// place of the usual one. Fails when the lead has stopped or is gone.
pub(crate) async fn question(
    core: &Arc<Core>,
    from: String,
    to: String,
    text: String,
    note: String,
) -> Result<Value, String> {
    let (target, letter) = {
        let core = core.clone();
        blocking(move || {
            let agents = listed(&core);
            let target = agents
                .iter()
                .find(|agent| agent.agent_id == to && agent.reach != Reach::Stopped)
                .cloned()
                .ok_or("that agent is not running")?;
            Ok((
                target,
                letter_from(&agents, Kind::Question, from, text, Some(note)),
            ))
        })
        .await
        .map_err(|error| error.to_string())?
    };
    deliver(core, &target, letter).await
}

/// Hands an agent the person's answer to the question it asked.
pub(crate) async fn answer(
    core: &Arc<Core>,
    to: String,
    answered: Answered,
    text: String,
    note: String,
) -> Result<Value, String> {
    let target = {
        let core = core.clone();
        let to = to.clone();
        blocking(move || {
            listed(&core)
                .into_iter()
                .find(|agent| agent.agent_id == to)
                .ok_or_else(|| "that agent is gone".into())
        })
        .await
        .map_err(|error| error.to_string())?
    };
    let letter = Letter {
        kind: Kind::Answer,
        from_id: "person".to_owned(),
        from_name: "the person".to_owned(),
        cli: "person".to_owned(),
        text,
        at: unix_ms(),
        note: Some(note),
        answers: Some(answered),
    };
    deliver(core, &target, letter).await
}

/// Hands an agent a note from Sikemux's board about its cards. Fails when the
/// agent has stopped or is gone.
pub(crate) async fn from_board(
    core: &Arc<Core>,
    to: String,
    text: String,
    note: String,
) -> Result<Value, String> {
    let target = {
        let core = core.clone();
        blocking(move || {
            listed(&core)
                .into_iter()
                .find(|agent| agent.agent_id == to && agent.reach != Reach::Stopped)
                .ok_or_else(|| "that agent is not running".into())
        })
        .await
        .map_err(|error| error.to_string())?
    };
    let letter = Letter {
        kind: Kind::Message,
        from_id: BOARD.to_owned(),
        from_name: "Board".to_owned(),
        cli: "sikemux".to_owned(),
        text,
        at: unix_ms(),
        note: Some(note),
        answers: None,
    };
    deliver(core, &target, letter).await
}

const AUTO_NOTE: &str = "Sent by Sikemux's Auto, which runs this project's board for the person, not by the person or another agent.";

fn auto_letter(text: String) -> Letter {
    Letter {
        kind: Kind::Message,
        from_id: "auto".to_owned(),
        from_name: "Auto".to_owned(),
        cli: "sikemux".to_owned(),
        text,
        at: unix_ms(),
        note: Some(AUTO_NOTE.to_owned()),
        answers: None,
    }
}

/// The task Auto gives an agent it started, as that agent reads it.
pub(crate) fn auto_task(text: String) -> String {
    wrapped(&auto_letter(text))
}

/// Auto tells an agent of its own what its card needs next.
pub(crate) async fn from_auto(core: &Arc<Core>, to: String, text: String) -> Result<Value, String> {
    let target = {
        let core = core.clone();
        blocking(move || {
            listed(&core)
                .into_iter()
                .find(|agent| agent.agent_id == to && agent.reach != Reach::Stopped)
                .ok_or_else(|| "that agent is not running".into())
        })
        .await
        .map_err(|error| error.to_string())?
    };
    deliver(core, &target, auto_letter(text)).await
}

/// Drops the messages holding `mark` that still wait for the agent.
pub(crate) fn withdraw(core: &Core, agent_id: &str, mark: &str) {
    if !is_waiting(core, agent_id, mark) {
        return;
    }
    let withdrawn = core.harness.mailbox.change(|state| {
        let Some(waiting) = state.waiting.get_mut(agent_id) else {
            return Vec::new();
        };
        let (withdrawn, kept) = std::mem::take(waiting)
            .into_iter()
            .partition(|queued| queued.text.contains(mark));
        *waiting = kept;
        withdrawn
    });
    log(core, agent_id, &withdrawn, Outcome::Dropped);
}

/// Whether a message holding `mark` still waits for the agent's turn to end.
pub(crate) fn is_waiting(core: &Core, agent_id: &str, mark: &str) -> bool {
    core.harness
        .mailbox
        .lock()
        .waiting
        .get(agent_id)
        .is_some_and(|waiting| waiting.iter().any(|queued| queued.text.contains(mark)))
}

fn letter_from(
    agents: &[Listed],
    kind: Kind,
    from: String,
    text: String,
    note: Option<String>,
) -> Letter {
    let sender = agents.iter().find(|agent| agent.agent_id == from);
    Letter {
        kind,
        from_name: sender
            .and_then(|agent| agent.name.clone())
            .unwrap_or_else(|| from.clone()),
        cli: sender.map_or_else(|| "agent".to_owned(), |agent| agent.cli.clone()),
        from_id: from,
        text,
        at: unix_ms(),
        note,
        answers: None,
    }
}

/// Hands `text` from `worker` to the agent that started it, as a message
/// about how its turn ended. Nothing is sent once the lead has stopped.
pub(crate) async fn report(core: &Arc<Core>, worker: String, lead: String, text: String) {
    let name = core.names.name(&worker);
    report_as(core, worker, name, lead, text).await;
}

/// [`report`] for a worker that may be gone, under the name it had.
pub(crate) async fn report_as(
    core: &Arc<Core>,
    worker: String,
    name: Option<String>,
    lead: String,
    text: String,
) {
    let found = {
        let core = core.clone();
        blocking(move || {
            let agents = listed(&core);
            let target = agents
                .iter()
                .find(|agent| agent.agent_id == lead && agent.reach != Reach::Stopped)
                .cloned();
            let name = name.unwrap_or_else(|| worker.clone());
            let note = format!(
                "{name} is an agent you started, and this is how its turn ended, sent by Sikemux. Reply with agent_send to {name} if it needs more."
            );
            let mut letter = letter_from(&agents, Kind::Report, worker, text, Some(note));
            letter.from_name = name;
            Ok(target.map(|target| (target, letter)))
        })
        .await
    };
    let Ok(Some((target, letter))) = found else {
        return;
    };
    if let Err(error) = deliver(core, &target, letter).await {
        eprintln!("sikemux core: an agent's report did not reach its lead: {error}");
    }
}

async fn deliver(core: &Arc<Core>, target: &Listed, letter: Letter) -> Result<Value, String> {
    let queued = Queued {
        text: wrapped(&letter),
        origin: Some(Origin {
            from: letter.from_id.clone(),
            kind: letter.kind,
        }),
    };
    let handed = handed(core, target, letter, &queued).await;
    let outcome = handed
        .as_ref()
        .map_or(Outcome::Refused, |(_, outcome)| *outcome);
    log(core, &target.agent_id, [&queued], outcome);
    handed.map(|(answer, _)| answer)
}

/// Hands `letter` to its agent, or leaves it waiting for the agent, and says
/// what became of it.
async fn handed(
    core: &Arc<Core>,
    target: &Listed,
    letter: Letter,
    queued: &Queued,
) -> Result<(Value, Outcome), String> {
    let name = target
        .name
        .clone()
        .unwrap_or_else(|| target.agent_id.clone());
    let answer = |delivery: &str, note: String| json!({ "to": name, "agentId": target.agent_id, "delivery": delivery, "note": note });
    let mailbox = &core.harness.mailbox;
    if let Admitted::Repeat { seconds_ago } = mailbox.admit(&letter, &target.agent_id, &name)? {
        return Ok((
            answer(
                "repeat",
                format!(
                    "You sent {name} the same text {seconds_ago} s ago, so it was not sent again."
                ),
            ),
            Outcome::Repeat,
        ));
    }
    let mut woke = "";
    let mut held = None;
    match target.reach {
        Reach::Chat | Reach::Terminal => {}
        Reach::Asleep if !core.window.is_open() => held = Some("is asleep while Sikemux is closed"),
        Reach::Asleep => {
            workspace::wake_chat(core, None, target.agent_id.clone())
                .await
                .map_err(|error| format!("{name} is asleep and did not wake: {error}"))?;
            mailbox.lock().wake_failed.remove(&target.agent_id);
            woke = " Sikemux woke it first.";
        }
        Reach::Stopped if letter.answers.is_some() => held = Some("has stopped"),
        Reach::Stopped => {
            return Err(format!(
                "{name} has stopped; it gets messages again once the person opens it"
            ))
        }
    }
    mailbox.note_sent(&letter, &target.agent_id);
    if letter.from_id != BOARD {
        super::board::reached_by_more_than_offer(core, &target.agent_id);
    }
    if held.is_none() && mailbox.has_waiting(&target.agent_id) {
        held = Some("already has messages waiting");
    }
    if held.is_none() {
        let delivered =
            match target.reach {
                Reach::Terminal => ready_terminal(core, &target.agent_id).map(|terminal| {
                    paste(core, &target.agent_id, terminal, vec![queued.clone()]);
                    Outcome::Typed
                }),
                _ => hand(core, &target.agent_id, &queued.text)
                    .await
                    .map(|delivered| match delivered {
                        Delivery::Steered => Outcome::Steered,
                        _ => Outcome::NewTurn,
                    }),
            };
        match delivered {
            Ok(Outcome::Steered) => {
                return Ok((
                    answer(
                        "steered",
                        format!("{name} is working and reads this at its next step.{woke}"),
                    ),
                    Outcome::Steered,
                ))
            }
            Ok(outcome) => {
                return Ok((
                    answer(
                        "newTurn",
                        format!("{name} was idle and started a turn to read this.{woke}"),
                    ),
                    outcome,
                ))
            }
            Err(busy) => held = Some(busy),
        }
    }
    let waiting = mailbox.wait(&target.agent_id, queued.clone());
    let busy = held.unwrap_or_default();
    Ok((
        answer(
            "waiting",
            format!("{name} {busy}, so it gets this once it is free, with any others waiting ({waiting} now).{woke}"),
        ),
        Outcome::Waiting,
    ))
}

fn rested(core: &Core, agent_id: &str) -> bool {
    core.seen
        .active_at(agent_id)
        .is_none_or(|at| unix_ms().saturating_sub(at) >= SETTLE_MS)
}

/// Hands `text` to the chat as one message, or says why it cannot take it
/// now.
async fn hand(core: &Core, agent_id: &str, text: &str) -> Result<Delivery, &'static str> {
    let chat = core.chats.get(agent_id).ok_or("is not running")?;
    if !chat.is_ready() {
        return Err("is still starting");
    }
    if !chat.turn_running() && !rested(core, agent_id) {
        return Err("has just finished a turn");
    }
    match chat::letter(core, agent_id, text.to_owned()).await {
        Ok(delivered @ (Delivery::Steered | Delivery::NewTurn)) => Ok(delivered),
        Ok(Delivery::TurnEnded) => Err("has just finished a turn"),
        Ok(Delivery::Refused) | Err(_) => Err("is working and cannot read messages mid-turn"),
    }
}

/// The terminal of an agent that waits for a prompt, or why it cannot take
/// one now.
fn ready_terminal(core: &Core, agent_id: &str) -> Result<Arc<Session>, &'static str> {
    let terminal = core
        .agent_session(agent_id)
        .ok_or("no longer has a terminal")?;
    if !agent::takes_prompt(core, &terminal) {
        let idle = terminal
            .agent
            .as_ref()
            .is_some_and(agent::AgentActivity::idle);
        return Err(if idle {
            "is still starting in its terminal"
        } else {
            "is working in its terminal"
        });
    }
    if !rested(core, agent_id) {
        return Err("has just finished a turn");
    }
    Ok(terminal)
}

/// Types `texts` into the agent's terminal as one pasted prompt. They count
/// as delivered only once the agent is seen to take them, and wait again if
/// it does not; Enter is held back from a permission prompt that came up
/// meanwhile.
fn paste(core: &Arc<Core>, agent_id: &str, terminal: Arc<Session>, texts: Vec<Queued>) {
    let plain: String = joined(&texts)
        .chars()
        .filter(|char| matches!(char, '\n' | '\t') || !char.is_control())
        .collect();
    let pastes = terminal
        .parser
        .lock()
        .is_ok_and(|parser| parser.screen().bracketed_paste());
    let typed = if pastes {
        format!("\x1b[200~{plain}\x1b[201~")
    } else {
        plain.replace('\n', " ")
    };
    core.harness.mailbox.change(|state| {
        state.delivering.insert(agent_id.to_owned());
        state.pasted.insert(
            agent_id.to_owned(),
            Pasted {
                texts,
                entered_at: None,
            },
        );
    });
    agent::note_input(core, &terminal, b"\r");
    session::queue_input(&terminal, typed.into_bytes(), Box::new(drop));
    let (core, agent_id) = (core.clone(), agent_id.to_owned());
    tokio::spawn(async move {
        tokio::time::sleep(ENTER_AFTER_PASTE).await;
        if agent::asks_now(&core, &terminal) {
            unpasted(&core, &agent_id);
            return;
        }
        session::queue_input(&terminal, b"\r".to_vec(), Box::new(drop));
        if let Some(pasted) = core.harness.mailbox.lock().pasted.get_mut(&agent_id) {
            pasted.entered_at = Some(unix_ms());
        }
    });
}

/// The paste the agent did not take waits again, ahead of the rest.
fn unpasted(core: &Core, agent_id: &str) {
    let returned = core.harness.mailbox.change(|state| {
        state.delivering.remove(agent_id);
        let pasted = state.pasted.remove(agent_id)?;
        put_back(state, agent_id, pasted.texts.clone());
        *state.missed_pastes.entry(agent_id.to_owned()).or_default() += 1;
        Some(pasted.texts)
    });
    log(core, agent_id, returned.iter().flatten(), Outcome::Returned);
}

/// The terminal agent was seen at work on a turn or asking the person
/// during one, so it took what was pasted, if anything was.
pub(crate) fn prompt_taken(core: &Core, agent_id: &str) {
    let mailbox = &core.harness.mailbox;
    let taken = {
        let mut state = mailbox.lock();
        state.missed_pastes.remove(agent_id);
        let entered = state
            .pasted
            .get(agent_id)
            .is_some_and(|pasted| pasted.entered_at.is_some());
        if !entered {
            return;
        }
        state.delivering.remove(agent_id);
        let taken = state.pasted.remove(agent_id);
        mailbox.kept.save(&state.record());
        taken
    };
    log(
        core,
        agent_id,
        taken.iter().flat_map(|pasted| &pasted.texts),
        Outcome::Delivered,
    );
}

/// The terminal agent came to rest, or stopped, after a turn. When the turn
/// followed a paste, it took the paste if it went on printing a while after
/// Enter, as a turn does; a swallowed Enter only redraws the prompt box. A
/// turn of its own makes it worth typing into again.
pub(crate) fn prompt_settled(core: &Core, agent_id: &str, last_output_ms: u64) {
    let entered_at = {
        let mut state = core.harness.mailbox.lock();
        match state.pasted.get(agent_id) {
            Some(pasted) => pasted.entered_at,
            None => {
                state.missed_pastes.remove(agent_id);
                return;
            }
        }
    };
    match entered_at {
        Some(at) if last_output_ms >= at + TURN_OUTPUT_MS => prompt_taken(core, agent_id),
        Some(_) => unpasted(core, agent_id),
        None => {}
    }
}

/// Gives each agent that has rested since its turn ended the messages
/// waiting for it, wakes an asleep chat that has some, and drops those for
/// agents that are gone.
pub(crate) fn deliver_waiting(core: &Arc<Core>) {
    let mailbox = &core.harness.mailbox;
    let pasted: Vec<String> = mailbox.lock().pasted.keys().cloned().collect();
    for agent_id in pasted {
        if core.agent_session(&agent_id).is_none() {
            unpasted(core, &agent_id);
        }
    }
    let due: Vec<String> = {
        let mut state = mailbox.lock();
        let State {
            waiting,
            wake_failed,
            missed_pastes,
            delivering,
            ..
        } = &mut *state;
        wake_failed.retain(|agent_id, _| waiting.contains_key(agent_id));
        missed_pastes.retain(|agent_id, _| waiting.contains_key(agent_id));
        waiting
            .keys()
            .filter(|agent_id| !delivering.contains(*agent_id))
            .cloned()
            .collect()
    };
    for agent_id in due {
        if let Some(chat) = core.chats.get(&agent_id) {
            if chat.is_ready() && !chat.turn_running() && rested(core, &agent_id) {
                deliver_later(core, agent_id, Pending::Chat);
            }
        } else if core.agent_session(&agent_id).is_some() {
            if mailbox.missed_pastes(&agent_id) >= MAX_MISSED_PASTES {
                continue;
            }
            if let Ok(terminal) = ready_terminal(core, &agent_id) {
                let texts = mailbox.take(&agent_id);
                if !texts.is_empty() {
                    paste(core, &agent_id, terminal, texts);
                }
            }
        } else if core.workspaces.published(&agent_id) == Some(true) {
            let failed = mailbox.lock().wake_failed.get(&agent_id).copied();
            let retry = failed.is_none_or(|at| unix_ms().saturating_sub(at) >= WAKE_RETRY_MS);
            if core.window.is_open() && retry {
                deliver_later(core, agent_id, Pending::Asleep);
            }
        } else if core.workspaces.closed(&agent_id) {
            log(core, &agent_id, &mailbox.take(&agent_id), Outcome::Dropped);
        }
    }
}

enum Pending {
    Chat,
    Asleep,
}

fn deliver_later(core: &Arc<Core>, agent_id: String, pending: Pending) {
    let mailbox = &core.harness.mailbox;
    if !mailbox.lock().delivering.insert(agent_id.clone()) {
        return;
    }
    let core = core.clone();
    tokio::spawn(async move {
        let mailbox = &core.harness.mailbox;
        match pending {
            Pending::Chat => {
                let texts = mailbox.take(&agent_id);
                if !texts.is_empty() {
                    match hand(&core, &agent_id, &joined(&texts)).await {
                        Ok(_) => log(&core, &agent_id, &texts, Outcome::Delivered),
                        Err(_) => mailbox.put_back(&agent_id, texts),
                    }
                }
            }
            Pending::Asleep => {
                let woke = workspace::wake_chat(&core, None, agent_id.clone()).await;
                let mut state = mailbox.lock();
                match woke {
                    Ok(_) => state.wake_failed.remove(&agent_id),
                    Err(_) => state.wake_failed.insert(agent_id.clone(), unix_ms()),
                };
            }
        }
        mailbox.lock().delivering.remove(&agent_id);
    });
}

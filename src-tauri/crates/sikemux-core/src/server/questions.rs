//! What `ask` answers, and Claude's own AskUserQuestion with it. An agent's
//! question goes first to the agent that started it, and to the person when
//! that agent passes it on, has stopped, or ends its turn without answering.
//! The person answers in the asker's chat, the notch or Sikemux's rail, and
//! the first answer reaches the asker as a message.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::cli::protocol::HarnessRequest;
use crate::protocol::WindowCall;

use super::activity::Activity;
use super::connection::ClientId;
use super::messages;
use super::names::project_of;
use super::notify::Signal;
use super::remote::unix_ms;
use super::Core;

const MAX_QUESTION_BYTES: usize = 8 * 1024;
const MAX_CHOICES: usize = 9;
const MAX_LABEL_CHARS: usize = 200;
const MAX_DETAIL_CHARS: usize = 400;
const MAX_ANSWER_BYTES: usize = 64 * 1024;
const MAX_OPEN_PER_AGENT: usize = 8;
/// A lead whose turn ended may still be handed the question back unread, so
/// it counts as passing it over only once this long has gone by.
const LEAD_GRACE_MS: u64 = 3_000;
const WINDOW_ANSWER_WAIT: Duration = Duration::from_secs(10);

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Choice {
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "stage")]
enum Stage {
    /// Sent to the agent that started the asker. `ended_at` is when that
    /// agent's turn ended after it was handed the question.
    #[serde(rename_all = "camelCase")]
    Lead {
        lead_id: String,
        lead_name: String,
        ended_at: Option<u64>,
    },
    /// Put to the person. `lead` is the agent it went to first, which
    /// `passed` it on itself rather than leaving it unanswered.
    #[serde(rename_all = "camelCase")]
    Person {
        lead: Option<(String, String)>,
        passed: bool,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Question {
    id: String,
    agent_id: String,
    name: String,
    cli: String,
    project: String,
    /// The asker's own words, which its chat shows the question under.
    asked: String,
    /// What the person is asked, which a lead that passes it on may reword.
    text: String,
    choices: Vec<Choice>,
    blocked: bool,
    assumption: Option<String>,
    at: u64,
    stage: Stage,
}

impl Question {
    fn view(&self) -> Value {
        let (lead, via, passed) = match &self.stage {
            Stage::Lead { lead_name, .. } => (Some(lead_name.clone()), None, false),
            Stage::Person { lead, passed } => {
                (None, lead.as_ref().map(|(_, name)| name.clone()), *passed)
            }
        };
        json!({
            "id": self.id,
            "agentId": self.agent_id,
            "name": self.name,
            "cli": self.cli,
            "project": self.project,
            "asked": self.asked,
            "text": self.text,
            "choices": self.choices,
            "blocked": self.blocked,
            "assumption": self.assumption,
            "at": self.at,
            "lead": lead,
            "via": via,
            "passed": passed,
        })
    }

    fn asks_person(&self) -> bool {
        matches!(self.stage, Stage::Person { .. })
    }

    fn lead_id(&self) -> Option<&str> {
        match &self.stage {
            Stage::Lead { lead_id, .. } => Some(lead_id),
            Stage::Person { .. } => None,
        }
    }
}

/// The questions still open, for a core that takes over.
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct QuestionsRecord {
    open: Vec<Question>,
}

#[derive(Default)]
struct State {
    open: Vec<Question>,
    /// Something changed that the window has not been sent yet.
    dirty: bool,
    /// The window connection last sent the questions.
    told_window: Option<ClientId>,
    /// The person's open questions phones were told of, and whose they are.
    told_phones: HashMap<String, String>,
    /// Every question put to the person, assumptions too, that devices'
    /// views last showed, and whose they are.
    shown_devices: HashMap<String, String>,
}

#[derive(Default)]
pub(crate) struct Questions {
    state: Mutex<State>,
}

/// A question as an agent asked it.
struct Asked {
    text: String,
    choices: Vec<Choice>,
    blocked: bool,
    assumption: Option<String>,
}

impl Questions {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub(crate) fn record(&self) -> QuestionsRecord {
        QuestionsRecord {
            open: self.lock().open.clone(),
        }
    }

    pub(crate) fn restore(&self, record: QuestionsRecord) {
        let mut state = self.lock();
        state.open = record.open;
        state.dirty = true;
    }

    /// Whether the agent waits on the person to answer a question.
    pub(crate) fn blocks_on_person(&self, agent_id: &str) -> bool {
        self.lock().open.iter().any(|question| {
            question.agent_id == agent_id && question.blocked && question.asks_person()
        })
    }

    /// Whether the agent stopped to wait for the answer to a question.
    pub(crate) fn waits_on_answer(&self, agent_id: &str) -> bool {
        self.lock()
            .open
            .iter()
            .any(|question| question.agent_id == agent_id && question.blocked)
    }

    /// Whether the agent has a question or an assumption the person has not
    /// answered.
    pub(crate) fn has_open(&self, agent_id: &str) -> bool {
        self.lock()
            .open
            .iter()
            .any(|question| question.agent_id == agent_id)
    }

    /// The boards changed, which may change the ticket a question names.
    pub(crate) fn boards_changed(&self) {
        let mut state = self.lock();
        if !state.open.is_empty() {
            state.dirty = true;
        }
    }

    /// A lead's message to its agent answers what that agent asked it.
    pub(crate) fn lead_replied(&self, lead: &str, agent_id: &str) {
        let mut state = self.lock();
        let before = state.open.len();
        state.open.retain(|question| {
            !(question.agent_id == agent_id && question.lead_id() == Some(lead))
        });
        if state.open.len() != before {
            state.dirty = true;
        }
    }

    /// The person typed into the terminal of an agent that asked them
    /// something, which answers it there.
    pub(crate) fn typed(&self, agent_id: &str) {
        let mut state = self.lock();
        let before = state.open.len();
        state
            .open
            .retain(|question| !(question.agent_id == agent_id && question.asks_person()));
        if state.open.len() != before {
            state.dirty = true;
        }
    }
}

/// The agent's turn ended, so a question it was handed and did not answer
/// goes on to the person.
pub(crate) fn turn_ended(core: &Core, agent_id: &str) {
    let questions = &core.harness.questions;
    let waiting: Vec<String> = questions
        .lock()
        .open
        .iter()
        .filter(|question| question.lead_id() == Some(agent_id))
        .map(|question| question.id.clone())
        .collect();
    let read: HashSet<String> = waiting
        .into_iter()
        .filter(|id| !messages::is_waiting(core, agent_id, id))
        .collect();
    if read.is_empty() {
        return;
    }
    let now = unix_ms();
    for question in &mut questions.lock().open {
        if let Stage::Lead { ended_at, .. } = &mut question.stage {
            if read.contains(&question.id) && ended_at.is_none() {
                *ended_at = Some(now);
            }
        }
    }
}

fn text_param(params: &Value, key: &str, max: usize) -> Result<Option<String>, String> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) if !text.trim().is_empty() && text.len() <= max => {
            Ok(Some(text.trim().to_owned()))
        }
        Some(Value::String(text)) if !text.trim().is_empty() => Err(format!(
            "{key} is {} bytes, more than the {max} it may hold",
            text.len()
        )),
        Some(_) => Err(format!("{key} must be nonempty text")),
    }
}

fn clipped(text: &str, max: usize) -> String {
    let text = text.trim();
    if text.chars().count() <= max {
        return text.to_owned();
    }
    let mut clipped: String = text.chars().take(max.saturating_sub(1)).collect();
    clipped.push('…');
    clipped
}

fn choices(value: Option<&Value>) -> Result<Vec<Choice>, String> {
    let list = match value {
        None | Some(Value::Null) => return Ok(Vec::new()),
        Some(Value::Array(list)) => list,
        Some(_) => return Err("choices must be a list".into()),
    };
    if list.len() > MAX_CHOICES {
        return Err(format!("choices holds at most {MAX_CHOICES}"));
    }
    list.iter()
        .map(|choice| {
            let (label, detail) = match choice {
                Value::String(label) => (label.as_str(), None),
                Value::Object(choice) => (
                    choice
                        .get("label")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                    choice
                        .get("detail")
                        .or_else(|| choice.get("description"))
                        .and_then(Value::as_str),
                ),
                _ => ("", None),
            };
            if label.trim().is_empty() {
                return Err("each choice needs a label".to_owned());
            }
            Ok(Choice {
                label: clipped(label, MAX_LABEL_CHARS),
                detail: detail
                    .filter(|detail| !detail.trim().is_empty())
                    .map(|detail| clipped(detail, MAX_DETAIL_CHARS)),
            })
        })
        .collect()
}

fn running(core: &Core, agent_id: &str) -> bool {
    core.chats.get(agent_id).is_some() || core.agent_session(agent_id).is_some()
}

/// Whether the person closed the agent, so its questions go with it.
fn gone(core: &Core, agent_id: &str) -> bool {
    !running(core, agent_id) && core.workspaces.closed(agent_id)
}

/// Whether a message reaches the agent now: it runs, or it sleeps in an open
/// window that wakes it. The window may not have said yet which chats it holds.
fn reachable(core: &Core, agent_id: &str) -> bool {
    running(core, agent_id)
        || (core.window.is_open()
            && !core.workspaces.closed(agent_id)
            && core.workspaces.published(agent_id) != Some(false))
}

fn busy(core: &Core, agent_id: &str) -> bool {
    if let Some(chat) = core.chats.get(agent_id) {
        return chat.turn_running();
    }
    core.agent_session(agent_id)
        .and_then(|session| session.agent.as_ref().map(|agent| !agent.idle()))
        .unwrap_or(false)
}

fn cli_of(core: &Core, agent_id: &str) -> String {
    core.chats
        .get(agent_id)
        .map(|chat| chat.provider().to_owned())
        .or_else(|| {
            core.agent_session(agent_id)
                .and_then(|session| session.info().agent_type)
        })
        .unwrap_or_else(|| "agent".to_owned())
}

/// Opens the questions `agent_id` asked together, put to its lead when it
/// has one a message reaches, else to the person. Opens none when they would
/// leave the agent with too many waiting.
fn open(
    core: &Core,
    agent_id: &str,
    project: &str,
    asked: Vec<Asked>,
) -> Result<Vec<Question>, String> {
    let named = core.names.get(agent_id);
    let lead = named
        .as_ref()
        .and_then(|named| named.parent.clone())
        .filter(|lead| reachable(core, lead));
    let stage = match lead {
        Some(lead_id) => Stage::Lead {
            lead_name: core.names.name(&lead_id).unwrap_or_else(|| lead_id.clone()),
            lead_id,
            ended_at: None,
        },
        None => Stage::Person {
            lead: None,
            passed: false,
        },
    };
    let name = named
        .as_ref()
        .map(|named| named.name.clone())
        .unwrap_or_else(|| agent_id.to_owned());
    let project = named.map(|named| named.project).unwrap_or_else(|| {
        project_of(
            std::path::Path::new(project),
            &core.workspaces.project_paths(),
        )
    });
    let cli = cli_of(core, agent_id);
    let at = unix_ms();
    let questions: Vec<Question> = asked
        .into_iter()
        .map(|asked| Question {
            id: format!("question-{}", uuid::Uuid::new_v4().simple()),
            agent_id: agent_id.to_owned(),
            name: name.clone(),
            cli: cli.clone(),
            project: project.clone(),
            asked: asked.text.clone(),
            text: asked.text,
            choices: asked.choices,
            blocked: asked.blocked,
            assumption: asked.assumption,
            at,
            stage: stage.clone(),
        })
        .collect();
    let mut state = core.harness.questions.lock();
    let open = state
        .open
        .iter()
        .filter(|open| open.agent_id == agent_id)
        .count();
    if open + questions.len() > MAX_OPEN_PER_AGENT {
        return Err(format!(
            "You would have more than {MAX_OPEN_PER_AGENT} questions waiting for answers; wait for those you asked first"
        ));
    }
    state.open.extend(questions.iter().cloned());
    state.dirty = true;
    Ok(questions)
}

fn moves_on(question: &Question) -> String {
    match &question.assumption {
        Some(assumption) => {
            format!("Go on assuming {assumption}. A message tells you if that is wrong.")
        }
        None => {
            "Stop here and end your turn without guessing: the answer comes to you as a message."
                .to_owned()
        }
    }
}

/// What the asker is told about where its question went.
fn sent_note(question: &Question) -> String {
    let to = match &question.stage {
        Stage::Lead { lead_name, .. } => {
            format!("Sent to {lead_name}, your lead, which answers it or asks the person.")
        }
        Stage::Person { .. } => "Sent to the person.".to_owned(),
    };
    format!("{to} {}", moves_on(question))
}

/// The question as the lead reads it.
fn for_lead(question: &Question) -> (String, String) {
    let name = &question.name;
    let mut text = question.text.clone();
    if !question.choices.is_empty() {
        text.push_str("\n\nChoices:");
        for (index, choice) in question.choices.iter().enumerate() {
            text.push_str(&format!("\n{}. {}", index + 1, choice.label));
            if let Some(detail) = &choice.detail {
                text.push_str(&format!(" — {detail}"));
            }
        }
    }
    match &question.assumption {
        Some(assumption) => text.push_str(&format!(
            "\n\n{name} goes on assuming {assumption} until it hears otherwise."
        )),
        None => text.push_str(&format!(
            "\n\n{name} waits for the answer before it goes on."
        )),
    }
    let note = format!(
        "{name}, an agent you started, asks you this. Answer it with agent_send to {name}. If you do not know, pass it to the person with ask, setting for to {name}. If your turn ends with neither, Sikemux asks the person. ({})",
        question.id
    );
    (text, note)
}

/// Hands a question that went to the asker's lead to it, or to the person
/// when the lead cannot take it.
async fn hand_to_lead(core: &Arc<Core>, question: &Question) {
    let Some(lead_id) = question.lead_id().map(str::to_owned) else {
        return;
    };
    let (text, note) = for_lead(question);
    if messages::tell(core, question.agent_id.clone(), lead_id, text, note)
        .await
        .is_ok()
    {
        return;
    }
    let mut state = core.harness.questions.lock();
    if let Some(open) = state.open.iter_mut().find(|open| open.id == question.id) {
        open.stage = Stage::Person {
            lead: None,
            passed: false,
        };
        state.dirty = true;
    }
}

pub(crate) async fn ask(core: &Arc<Core>, request: &HarnessRequest) -> Result<Value, String> {
    let agent_id = request
        .agent_id
        .clone()
        .ok_or("ask needs the calling agent's id")?;
    let params = &request.params;
    let text = text_param(params, "question", MAX_QUESTION_BYTES)?
        .ok_or("question must be what you want to know, as nonempty text")?;
    let choices = choices(params.get("choices"))?;
    if let Some(worker) = text_param(params, "for", 200)? {
        return pass_on(core, &agent_id, &worker, text, choices);
    }
    let blocked = match params.get("blocked") {
        None | Some(Value::Null) => true,
        Some(Value::Bool(blocked)) => *blocked,
        Some(_) => return Err("blocked must be a boolean".into()),
    };
    let assumption = text_param(params, "assumption", MAX_QUESTION_BYTES)?;
    match (blocked, &assumption) {
        (true, Some(_)) => {
            return Err(
                "assumption goes with blocked: false, when you carry on without the answer".into(),
            )
        }
        (false, None) => {
            return Err(
                "blocked: false needs assumption: what you go on assuming until you hear back"
                    .into(),
            )
        }
        _ => {}
    }
    let question = open(
        core,
        &agent_id,
        &request.project,
        vec![Asked {
            text,
            choices,
            blocked,
            assumption,
        }],
    )?
    .remove(0);
    hand_to_lead(core, &question).await;
    let question = core
        .harness
        .questions
        .lock()
        .open
        .iter()
        .find(|open| open.id == question.id)
        .cloned()
        .unwrap_or(question);
    Ok(json!({
        "questionId": question.id,
        "askedOf": match &question.stage {
            Stage::Lead { lead_name, .. } => lead_name.clone(),
            Stage::Person { .. } => "the person".to_owned(),
        },
        "note": sent_note(&question),
    }))
}

/// A lead passes a question its agent asked it on to the person.
fn pass_on(
    core: &Core,
    lead_id: &str,
    worker: &str,
    text: String,
    choices: Vec<Choice>,
) -> Result<Value, String> {
    let wanted = worker.trim().trim_start_matches('@');
    let lead_name = core
        .names
        .name(lead_id)
        .unwrap_or_else(|| lead_id.to_owned());
    let mut state = core.harness.questions.lock();
    let from = |question: &Question| {
        question.agent_id == wanted || question.name.eq_ignore_ascii_case(wanted)
    };
    let Some(question) = state
        .open
        .iter_mut()
        .find(|question| from(question) && question.lead_id() == Some(lead_id))
    else {
        let asked_already = state.open.iter().any(|question| {
            from(question)
                && matches!(&question.stage, Stage::Person { lead: Some((lead, _)), .. } if lead == lead_id)
        });
        return if asked_already {
            Ok(
                json!({ "note": format!("The person already has {wanted}'s question; carry on with your own work.") }),
            )
        } else {
            Err(format!(
                "{wanted} has no question waiting on you; leave out for to ask the person something yourself"
            ))
        };
    };
    question.text = text;
    if !choices.is_empty() {
        question.choices = choices;
    }
    question.stage = Stage::Person {
        lead: Some((lead_id.to_owned(), lead_name)),
        passed: true,
    };
    let (id, name) = (question.id.clone(), question.name.clone());
    state.dirty = true;
    Ok(json!({
        "questionId": id,
        "askedOf": "the person",
        "for": name,
        "note": format!("Sikemux asks the person for {name}. {name} gets the answer and you get a copy; carry on with your own work."),
    }))
}

/// Takes Claude's AskUserQuestion into the same questions, and says what
/// Claude is told in place of an answer.
pub(crate) fn ask_claude(core: &Arc<Core>, agent_id: &str, input: &Value) -> String {
    let asked: Vec<Asked> = input
        .get("questions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|question| {
            let text = question.get("question")?.as_str()?.trim();
            if text.is_empty() || text.len() > MAX_QUESTION_BYTES {
                return None;
            }
            let options = question
                .get("options")
                .and_then(Value::as_array)
                .map(|options| options.iter().take(MAX_CHOICES).cloned().collect());
            Some(Asked {
                text: text.to_owned(),
                choices: choices(options.map(Value::Array).as_ref()).unwrap_or_default(),
                blocked: true,
                assumption: None,
            })
        })
        .collect();
    if asked.is_empty() {
        return "Sikemux could not read that question; ask it again with the ask tool.".into();
    }
    let project = core
        .chats
        .get(agent_id)
        .map(|chat| chat.launch.cwd.to_string_lossy().into_owned())
        .unwrap_or_default();
    let opened = match open(core, agent_id, &project, asked) {
        Ok(opened) => opened,
        Err(error) => return error,
    };
    let to = match opened.first().map(|question| &question.stage) {
        Some(Stage::Lead { lead_name, .. }) => format!("{lead_name}, your lead,"),
        _ => "the person".to_owned(),
    };
    let core = core.clone();
    tokio::spawn(async move {
        for question in &opened {
            hand_to_lead(&core, question).await;
        }
    });
    format!(
        "Sikemux put this question to {to} in place of this tool, so do not ask it again. Stop here and end your turn without guessing: the answer comes to you as your next message."
    )
}

/// The open questions, for the app, the notch and phones.
pub(crate) fn views(core: &Core) -> Vec<Value> {
    let open = core.harness.questions.lock().open.clone();
    with_tickets(core, open)
}

/// Each question's view, with the ticket of the card its asker holds.
fn with_tickets(core: &Core, open: Vec<Question>) -> Vec<Value> {
    open.iter()
        .map(|question| {
            let mut view = question.view();
            if let (Some(ticket), Some(fields)) = (
                super::board::ticket_of_agent(core, &question.agent_id),
                view.as_object_mut(),
            ) {
                fields.insert("ticket".into(), ticket.into());
            }
            view
        })
        .collect()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AnswerParams {
    id: String,
    #[serde(default)]
    answer: Option<String>,
    #[serde(default)]
    choice: Option<usize>,
    /// The assumption the agent went on is right.
    #[serde(default)]
    fine: bool,
}

/// The person's answer: the first one wins, and reaches the asker as a
/// message.
pub(crate) async fn answer(core: &Arc<Core>, params: AnswerParams) -> Result<Value, String> {
    let question = {
        let mut state = core.harness.questions.lock();
        let index = state
            .open
            .iter()
            .position(|question| question.id == params.id)
            .ok_or("That question has been answered already")?;
        let text = answer_text(&state.open[index], &params)?;
        let question = state.open.remove(index);
        state.dirty = true;
        (question, text)
    };
    let (question, text) = question;
    let Some(text) = text else {
        return Ok(json!({ "answered": true }));
    };
    let note = match &question.assumption {
        Some(assumption) => format!(
            "The person answered the question you went on without. If that is not what you assumed ({assumption}), change course."
        ),
        None => "The person answered the question you asked; go on with it.".to_owned(),
    };
    let answered = |question_text: &str| messages::Answered {
        question: question_text.to_owned(),
        asker: question.name.clone(),
        cli: question.cli.clone(),
    };
    if let Err(error) = messages::answer(
        core,
        question.agent_id.clone(),
        answered(&question.asked),
        text.clone(),
        note,
    )
    .await
    {
        let mut state = core.harness.questions.lock();
        state.open.push(question);
        state.dirty = true;
        return Err(error);
    }
    if let Stage::Person {
        lead: Some((lead_id, _)),
        ..
    } = &question.stage
    {
        let note = format!(
            "The person answered {}'s question, which went to you first. {} has the answer too.",
            question.name, question.name
        );
        let _ = messages::answer(core, lead_id.clone(), answered(&question.text), text, note).await;
    }
    Ok(json!({ "answered": true }))
}

/// What the person's answer says, or none when they only agreed with the
/// assumption the agent went on.
fn answer_text(question: &Question, params: &AnswerParams) -> Result<Option<String>, String> {
    if params.fine {
        return match question.assumption {
            Some(_) => Ok(None),
            None => Err("Only an assumption can be agreed with; answer the question".into()),
        };
    }
    if let Some(choice) = params.choice {
        return question
            .choices
            .get(choice)
            .map(|choice| Some(choice.label.clone()))
            .ok_or_else(|| "That choice is not one of the question's".into());
    }
    match params.answer.as_deref().map(str::trim) {
        Some(text) if !text.is_empty() && text.len() <= MAX_ANSWER_BYTES => {
            Ok(Some(text.to_owned()))
        }
        Some(text) if !text.is_empty() => Err(format!(
            "An answer holds at most {} KB",
            MAX_ANSWER_BYTES / 1024
        )),
        _ => Err("The answer is empty".into()),
    }
}

/// Moves on questions their lead left, drops those of agents that are gone,
/// and tells the window and phones what changed.
pub(crate) fn tick(core: &Arc<Core>) {
    let (askers, leads): (HashSet<String>, HashSet<String>) = {
        let state = core.harness.questions.lock();
        if state.open.is_empty()
            && state.told_phones.is_empty()
            && state.shown_devices.is_empty()
            && !state.dirty
        {
            drop(state);
            tell_window(core);
            return;
        }
        (
            state
                .open
                .iter()
                .map(|question| question.agent_id.clone())
                .collect(),
            state
                .open
                .iter()
                .filter_map(|question| question.lead_id().map(str::to_owned))
                .collect(),
        )
    };
    let gone: HashSet<String> = askers
        .into_iter()
        .filter(|agent_id| gone(core, agent_id))
        .collect();
    let leads: HashMap<String, (bool, bool)> = leads
        .into_iter()
        .map(|lead| {
            let state = (reachable(core, &lead), busy(core, &lead));
            (lead, state)
        })
        .collect();
    let unread: HashSet<String> = {
        let state = core.harness.questions.lock();
        state
            .open
            .iter()
            .filter_map(|question| {
                let lead = question.lead_id()?;
                messages::is_waiting(core, lead, &question.id).then(|| question.id.clone())
            })
            .collect()
    };
    let now = unix_ms();
    let mut withdrawn = Vec::new();
    {
        let mut state = core.harness.questions.lock();
        let before = state.open.len();
        state
            .open
            .retain(|question| !gone.contains(&question.agent_id));
        let mut changed = state.open.len() != before;
        for question in &mut state.open {
            let Stage::Lead {
                lead_id,
                lead_name,
                ended_at,
            } = &mut question.stage
            else {
                continue;
            };
            let (reachable, busy) = leads
                .get(lead_id.as_str())
                .copied()
                .unwrap_or((false, false));
            let unread = unread.contains(&question.id);
            let passed_over =
                ended_at.is_some_and(|at| now.saturating_sub(at) >= LEAD_GRACE_MS) && !unread;
            if busy {
                *ended_at = None;
            } else if !reachable || passed_over {
                if unread {
                    withdrawn.push((lead_id.clone(), question.id.clone()));
                }
                question.stage = Stage::Person {
                    lead: (!unread).then(|| (lead_id.clone(), lead_name.clone())),
                    passed: false,
                };
                changed = true;
            }
        }
        if changed {
            state.dirty = true;
        }
    }
    for (lead, question) in withdrawn {
        messages::withdraw(core, &lead, &question);
    }
    tell_phones(core);
    tell_window(core);
}

/// Tells phones of each question that now waits on the person, and of each
/// that no longer does. An agent whose questions to the person changed counts
/// as active, which changes the view devices are sent, so they read the
/// questions again.
fn tell_phones(core: &Core) {
    let (asked, cleared, changed) = {
        let mut state = core.harness.questions.lock();
        let shown: HashMap<String, String> = state
            .open
            .iter()
            .filter(|question| question.asks_person())
            .map(|question| (question.id.clone(), question.agent_id.clone()))
            .collect();
        let changed: HashSet<String> = shown
            .iter()
            .filter(|(id, _)| !state.shown_devices.contains_key(*id))
            .chain(
                state
                    .shown_devices
                    .iter()
                    .filter(|(id, _)| !shown.contains_key(*id)),
            )
            .map(|(_, agent_id)| agent_id.clone())
            .collect();
        state.shown_devices = shown;
        let now: HashMap<String, Question> = state
            .open
            .iter()
            .filter(|question| question.blocked && question.asks_person())
            .map(|question| (question.id.clone(), question.clone()))
            .collect();
        let asked: Vec<Question> = now
            .values()
            .filter(|question| !state.told_phones.contains_key(&question.id))
            .cloned()
            .collect();
        let cleared: Vec<(String, String)> = state
            .told_phones
            .iter()
            .filter(|(id, _)| !now.contains_key(*id))
            .map(|(id, agent_id)| (id.clone(), agent_id.clone()))
            .collect();
        state.told_phones = now
            .into_iter()
            .map(|(id, question)| (id, question.agent_id))
            .collect();
        (asked, cleared, changed)
    };
    for agent_id in changed {
        core.seen.active(&agent_id);
    }
    for question in asked {
        core.note_activity(&question.agent_id, Activity::NeedsYou);
        core.notify.send(Signal::Question {
            id: question.id,
            agent_id: question.agent_id,
            name: question.name,
            text: question.text,
            at: question.at,
        });
    }
    for (id, agent_id) in cleared {
        core.notify.send(Signal::QuestionCleared { id, agent_id });
    }
}

/// Sends the window the open questions when they changed, or when a window
/// opened that has not had them.
fn tell_window(core: &Arc<Core>) {
    let window = core.window.client_id();
    let open = {
        let mut state = core.harness.questions.lock();
        if !state.dirty && state.told_window == window {
            return;
        }
        state.dirty = false;
        state.told_window = window;
        if window.is_none() {
            return;
        }
        state.open.clone()
    };
    let views = with_tickets(core, open);
    let request = json!({
        "id": "agent-questions",
        "project": "/",
        "agentId": null,
        "method": "agent.questions",
        "params": { "questions": views },
    });
    let Ok(call) = core.window.call(
        WindowCall::Harness { request },
        "show agents' questions",
        false,
    ) else {
        return;
    };
    let id = call.id;
    let core = core.clone();
    tokio::spawn(async move {
        if tokio::time::timeout(WINDOW_ANSWER_WAIT, call.answer)
            .await
            .is_err()
        {
            core.window.forget(id);
        }
    });
}

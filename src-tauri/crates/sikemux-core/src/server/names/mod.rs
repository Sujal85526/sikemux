//! What each agent is called: a word the core gives it from a built-in list
//! when it starts. No two agents of a project share one, and a name is not
//! given again while the agent that had it is among the project's recent
//! ones. Kept in `agent-names.json` in the data folder, so names outlive a
//! window reload, a restart and an update.

mod words;

use std::cmp::Reverse;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};

use super::remote::unix_ms;
use words::WORDS;

const FILE: &str = "agent-names.json";
/// How many of a project's past agents keep their names out of use, newest first.
const KEPT_PAST: usize = 100;
const MAX_NAME_CHARS: usize = 24;
/// How many agents below one the person started may start agents of their own.
const MAX_DEPTH: usize = 2;
const MAX_CHILDREN: usize = 6;
const MAX_SPAWNED_PER_PROJECT: usize = 8;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    agent_id: String,
    name: String,
    project: String,
    /// The agent that started this one.
    #[serde(default)]
    parent: Option<String>,
    /// Its turns end without its final answer going to the agent that
    /// started it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    quiet: bool,
    #[serde(default)]
    provider: Option<String>,
    /// The provider's own session, so a chat opened again from the recent
    /// list gets its name back.
    #[serde(default)]
    session_id: Option<String>,
    /// When it was named, in Unix milliseconds.
    at: u64,
}

impl Entry {
    fn view(&self) -> AgentName {
        AgentName {
            agent_id: self.agent_id.clone(),
            name: self.name.clone(),
            project: self.project.clone(),
            parent: self.parent.clone(),
        }
    }
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Book {
    agents: Vec<Entry>,
    /// Every agent the app holds, sleeping ones included, as it last said.
    /// Unknown until the app first says.
    #[serde(default)]
    in_app: Option<HashSet<String>>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentName {
    pub agent_id: String,
    pub name: String,
    pub project: String,
    pub parent: Option<String>,
}

/// An agent another agent starts.
pub(crate) struct Worker<'a> {
    pub agent_id: &'a str,
    pub lead: &'a str,
    pub provider: &'a str,
    /// Its final answer goes to its lead each time its turn ends.
    pub reports: bool,
}

/// An agent that wants a name.
pub(crate) struct Starting<'a> {
    pub agent_id: &'a str,
    pub project: String,
    pub provider: Option<&'a str>,
    /// The provider session it takes up again, if any.
    pub resume_id: Option<&'a str>,
}

pub(crate) struct Names {
    book: Mutex<Book>,
    path: Option<PathBuf>,
}

impl Names {
    pub(crate) fn new(data_dir: Option<&Path>) -> Self {
        let path = data_dir.map(|dir| dir.join(FILE));
        let book = path.as_deref().map(load).unwrap_or_default();
        Self {
            book: Mutex::new(book),
            path,
        }
    }

    fn lock(&self) -> MutexGuard<'_, Book> {
        self.book
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub(crate) fn name(&self, agent_id: &str) -> Option<String> {
        self.lock()
            .agents
            .iter()
            .find(|entry| entry.agent_id == agent_id)
            .map(|entry| entry.name.clone())
    }

    pub(crate) fn get(&self, agent_id: &str) -> Option<AgentName> {
        self.lock()
            .agents
            .iter()
            .find(|entry| entry.agent_id == agent_id)
            .map(Entry::view)
    }

    /// The agent's name, given now when it has none, and whether that changed
    /// anything. `running` holds the agents running here.
    pub(crate) fn give(
        &self,
        starting: Starting<'_>,
        running: HashSet<String>,
    ) -> (AgentName, bool) {
        let mut book = self.lock();
        let open = book.open(running);
        let (named, changed) = book.give(starting, &open);
        if changed {
            if book.in_app.is_some() {
                book.prune(&named.project, &open);
            }
            self.save(&book);
        }
        (named, changed)
    }

    /// Names a worker for `worker.lead`, in the lead's project, unless the
    /// lead may not start another. `running` holds the agents running here.
    pub(crate) fn hire(
        &self,
        worker: Worker<'_>,
        running: HashSet<String>,
    ) -> Result<AgentName, String> {
        let mut book = self.lock();
        let open = book.open(running);
        let lead = book
            .agents
            .iter()
            .find(|entry| entry.agent_id == worker.lead)
            .cloned()
            .ok_or("Sikemux has not named you yet; try again in a moment")?;
        if book.depth(worker.lead) >= MAX_DEPTH {
            return Err(format!(
                "{} is already {MAX_DEPTH} levels below an agent the person started, so it cannot start agents; do this work yourself or hand it back to your lead",
                lead.name
            ));
        }
        let live = |entry: &&Entry| open.contains(&entry.agent_id);
        let children = book
            .agents
            .iter()
            .filter(live)
            .filter(|entry| entry.parent.as_deref() == Some(worker.lead))
            .count();
        if children >= MAX_CHILDREN {
            return Err(format!(
                "{} already has {MAX_CHILDREN} agents of its own open, the most one agent may have; give one of them the work, or ask the person to close one that is done",
                lead.name
            ));
        }
        let spawned = book
            .agents
            .iter()
            .filter(live)
            .filter(|entry| entry.project == lead.project && entry.parent.is_some())
            .count();
        if spawned >= MAX_SPAWNED_PER_PROJECT {
            return Err(format!(
                "this project already has {MAX_SPAWNED_PER_PROJECT} agents that agents started open, the most it may have; give one of them the work, or ask the person to close one that is done"
            ));
        }
        let entry = Entry {
            agent_id: worker.agent_id.to_owned(),
            name: book.fresh(&lead.project, worker.agent_id, &open),
            project: lead.project,
            parent: Some(worker.lead.to_owned()),
            quiet: !worker.reports,
            provider: Some(worker.provider.to_owned()),
            session_id: None,
            at: unix_ms(),
        };
        let named = entry.view();
        book.agents.push(entry);
        self.save(&book);
        Ok(named)
    }

    /// The agent that hears how the agent's turns end, if any.
    pub(crate) fn reports_to(&self, agent_id: &str) -> Option<String> {
        self.lock()
            .agents
            .iter()
            .find(|entry| entry.agent_id == agent_id && !entry.quiet)
            .and_then(|entry| entry.parent.clone())
    }

    /// The agent at the top of `agent_id`'s chain of leads, the one the person
    /// started, which names its team.
    pub(crate) fn team_of(&self, agent_id: &str) -> String {
        let book = self.lock();
        let mut current = agent_id;
        for _ in 0..=book.agents.len() {
            match book.parent(current) {
                Some(parent) => current = parent,
                None => break,
            }
        }
        current.to_owned()
    }

    /// Whether `lead` started `agent_id`, or started an agent that did.
    pub(crate) fn leads(&self, lead: &str, agent_id: &str) -> bool {
        let book = self.lock();
        let mut current = agent_id;
        for _ in 0..=book.agents.len() {
            match book.parent(current) {
                Some(parent) if parent == lead => return true,
                Some(parent) => current = parent,
                None => break,
            }
        }
        false
    }

    /// Takes the app's word for which agents it holds.
    pub(crate) fn set_in_app(&self, agent_ids: HashSet<String>) {
        let mut book = self.lock();
        if book.in_app.as_ref() == Some(&agent_ids) {
            return;
        }
        book.in_app = Some(agent_ids);
        self.save(&book);
    }

    /// The provider session the agent runs, once it is known.
    pub(crate) fn session_of(&self, agent_id: &str) -> Option<String> {
        self.lock()
            .agents
            .iter()
            .find(|entry| entry.agent_id == agent_id)
            .and_then(|entry| entry.session_id.clone())
    }

    pub(crate) fn note_session(&self, agent_id: &str, session_id: &str) {
        let mut book = self.lock();
        let Some(entry) = book.entry_mut(agent_id) else {
            return;
        };
        if entry.session_id.as_deref() == Some(session_id) {
            return;
        }
        entry.session_id = Some(session_id.to_owned());
        self.save(&book);
    }

    /// The person's own name for the agent. A past agent of the project that
    /// had it gives it up; an open one keeps it.
    pub(crate) fn rename(
        &self,
        agent_id: &str,
        name: &str,
        running: HashSet<String>,
    ) -> Result<AgentName, String> {
        let name = valid_name(name)?;
        let mut book = self.lock();
        let open = book.open(running);
        let project = book
            .entry_mut(agent_id)
            .ok_or("Sikemux has not named that agent yet")?
            .project
            .clone();
        let holder = book.agents.iter().find(|entry| {
            entry.agent_id != agent_id && entry.project == project && same(&entry.name, &name)
        });
        if let Some(holder) = holder.filter(|holder| open.contains(&holder.agent_id)) {
            return Err(format!(
                "another agent in this project is called {}",
                holder.name
            ));
        }
        book.agents.retain(|entry| {
            entry.agent_id == agent_id || entry.project != project || !same(&entry.name, &name)
        });
        let entry = book
            .entry_mut(agent_id)
            .ok_or("Sikemux has not named that agent yet")?;
        entry.name = name;
        let named = entry.view();
        self.save(&book);
        Ok(named)
    }

    fn save(&self, book: &Book) {
        let Some(path) = &self.path else {
            return;
        };
        let written = serde_json::to_vec(book)
            .map_err(std::io::Error::from)
            .and_then(|bytes| sikemux_process::files::write_atomic(path, &bytes, true));
        if let Err(error) = written {
            eprintln!("sikemux core: agents' names were not saved: {error}");
        }
    }
}

impl Book {
    fn open(&self, mut running: HashSet<String>) -> HashSet<String> {
        running.extend(self.in_app.iter().flatten().cloned());
        running
    }

    fn parent(&self, agent_id: &str) -> Option<&str> {
        self.agents
            .iter()
            .find(|entry| entry.agent_id == agent_id)
            .and_then(|entry| entry.parent.as_deref())
    }

    /// How many agents up the chain of leads the person's own agent is.
    fn depth(&self, agent_id: &str) -> usize {
        let mut depth = 0;
        let mut current = agent_id;
        while let Some(parent) = self.parent(current) {
            depth += 1;
            if depth > self.agents.len() {
                break;
            }
            current = parent;
        }
        depth
    }

    fn entry_mut(&mut self, agent_id: &str) -> Option<&mut Entry> {
        self.agents
            .iter_mut()
            .find(|entry| entry.agent_id == agent_id)
    }

    /// The agent's name, and whether the book changed to give it.
    fn give(&mut self, starting: Starting<'_>, open: &HashSet<String>) -> (AgentName, bool) {
        let Starting {
            agent_id,
            project,
            provider,
            resume_id,
        } = starting;
        let current = self
            .agents
            .iter()
            .find(|entry| entry.agent_id == agent_id)
            .map(|entry| (entry.project != project, entry.name.clone()));
        if let Some((moved, kept)) = current {
            let name = if moved && self.taken(&project, &kept, agent_id) {
                self.fresh(&project, agent_id, open)
            } else {
                kept
            };
            if let Some(entry) = self.entry_mut(agent_id) {
                let mut changed = moved;
                if moved {
                    entry.project = project;
                    entry.name = name;
                    entry.at = unix_ms();
                }
                if let Some(provider) = provider.filter(|p| entry.provider.as_deref() != Some(*p)) {
                    entry.provider = Some(provider.to_owned());
                    changed = true;
                }
                if let Some(session) = resume_id.filter(|s| entry.session_id.as_deref() != Some(*s))
                {
                    entry.session_id = Some(session.to_owned());
                    changed = true;
                }
                return (entry.view(), changed);
            }
        }
        let resumed = resume_id.and_then(|session| {
            self.position(|entry| {
                entry.project == project
                    && entry.session_id.as_deref() == Some(session)
                    && (provider.is_none() || entry.provider.as_deref() == provider)
                    && !open.contains(&entry.agent_id)
            })
        });
        if let Some(index) = resumed {
            let entry = &mut self.agents[index];
            entry.agent_id = agent_id.to_owned();
            entry.at = unix_ms();
            return (entry.view(), true);
        }
        let name = self.fresh(&project, agent_id, open);
        let entry = Entry {
            agent_id: agent_id.to_owned(),
            name,
            project,
            parent: None,
            quiet: false,
            provider: provider.map(str::to_owned),
            session_id: resume_id.map(str::to_owned),
            at: unix_ms(),
        };
        let named = entry.view();
        self.agents.push(entry);
        (named, true)
    }

    fn position(&self, find: impl Fn(&Entry) -> bool) -> Option<usize> {
        self.agents.iter().position(find)
    }

    fn taken(&self, project: &str, name: &str, except: &str) -> bool {
        self.agents.iter().any(|entry| {
            entry.agent_id != except && entry.project == project && same(&entry.name, name)
        })
    }

    /// A word no agent of the project has, starting differently from the
    /// open ones' so they are told apart at a glance.
    fn fresh(&mut self, project: &str, agent_id: &str, open: &HashSet<String>) -> String {
        let others: Vec<&Entry> = self
            .agents
            .iter()
            .filter(|entry| entry.project == project && entry.agent_id != agent_id)
            .collect();
        let used: HashSet<String> = others
            .iter()
            .map(|entry| entry.name.to_lowercase())
            .collect();
        let open_starts: HashSet<String> = others
            .iter()
            .filter(|entry| open.contains(&entry.agent_id))
            .map(|entry| start(&entry.name))
            .collect();
        let unused: Vec<&str> = WORDS
            .iter()
            .copied()
            .filter(|word| !used.contains(&word.to_lowercase()))
            .collect();
        let distinct: Vec<&str> = unused
            .iter()
            .copied()
            .filter(|word| !open_starts.contains(&start(word)))
            .collect();
        if let Some(word) = pick(&distinct).or_else(|| pick(&unused)) {
            return word.to_owned();
        }
        let oldest_past = self
            .agents
            .iter()
            .enumerate()
            .filter(|(_, entry)| {
                entry.project == project
                    && entry.agent_id != agent_id
                    && !open.contains(&entry.agent_id)
            })
            .min_by_key(|(_, entry)| entry.at)
            .map(|(index, _)| index);
        if let Some(index) = oldest_past {
            return self.agents.remove(index).name;
        }
        let word = pick(WORDS).unwrap_or("Agent");
        (2..)
            .map(|number| format!("{word}{number}"))
            .find(|name| !used.contains(&name.to_lowercase()))
            .unwrap_or_else(|| word.to_owned())
    }

    /// Lets go of the names of the project's oldest past agents.
    fn prune(&mut self, project: &str, open: &HashSet<String>) {
        let mut past: Vec<(u64, String)> = self
            .agents
            .iter()
            .filter(|entry| entry.project == project && !open.contains(&entry.agent_id))
            .map(|entry| (entry.at, entry.agent_id.clone()))
            .collect();
        if past.len() <= KEPT_PAST {
            return;
        }
        past.sort_by_key(|(at, _)| Reverse(*at));
        let dropped: HashSet<String> = past
            .into_iter()
            .skip(KEPT_PAST)
            .map(|(_, agent_id)| agent_id)
            .collect();
        self.agents
            .retain(|entry| !dropped.contains(&entry.agent_id));
    }
}

fn same(a: &str, b: &str) -> bool {
    a.to_lowercase() == b.to_lowercase()
}

fn start(name: &str) -> String {
    name.chars().take(2).collect::<String>().to_lowercase()
}

fn pick<'a>(words: &[&'a str]) -> Option<&'a str> {
    if words.is_empty() {
        return None;
    }
    let roll = uuid::Uuid::new_v4().as_u128();
    words.get((roll % words.len() as u128) as usize).copied()
}

fn valid_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    let mut chars = name.chars();
    let fits = chars.next().is_some_and(char::is_alphabetic)
        && chars.all(char::is_alphanumeric)
        && name.chars().count() <= MAX_NAME_CHARS;
    if fits {
        Ok(name.to_owned())
    } else {
        Err(format!(
            "a name is one word of up to {MAX_NAME_CHARS} letters and digits, starting with a letter"
        ))
    }
}

fn load(path: &Path) -> Book {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|error| {
            eprintln!(
                "sikemux core: {} could not be read, so agents are named afresh: {error}",
                path.display()
            );
            Book::default()
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Book::default(),
        Err(error) => {
            eprintln!(
                "sikemux core: {} could not be read, so agents are named afresh: {error}",
                path.display()
            );
            Book::default()
        }
    }
}

/// The project an agent working in `cwd` belongs to: the app's project that
/// holds it, else `cwd` itself. A folder in a git worktree counts as the same
/// folder in the main checkout.
pub(crate) fn project_of(cwd: &Path, projects: &[PathBuf]) -> String {
    let canonical = |path: &Path| std::fs::canonicalize(path).unwrap_or_else(|_| path.to_owned());
    let cwd = canonical(cwd);
    let path = in_main_checkout(&cwd).unwrap_or(cwd);
    projects
        .iter()
        .map(|project| canonical(project))
        .filter(|project| path.starts_with(project))
        .max_by_key(|project| project.as_os_str().len())
        .unwrap_or(path)
        .to_string_lossy()
        .into_owned()
}

/// The folder in the main checkout matching `cwd` in a linked git worktree.
fn in_main_checkout(cwd: &Path) -> Option<PathBuf> {
    let root = cwd.ancestors().find(|dir| dir.join(".git").exists())?;
    let main = main_checkout(root)?;
    let inside = cwd.strip_prefix(root).ok()?;
    Some(if inside.as_os_str().is_empty() {
        main
    } else {
        main.join(inside)
    })
}

/// Where a linked git worktree's main checkout is. A linked worktree's `.git`
/// is a file naming its folder under the main checkout's `.git`.
fn main_checkout(root: &Path) -> Option<PathBuf> {
    let link = std::fs::read_to_string(root.join(".git")).ok()?;
    let gitdir = root.join(link.strip_prefix("gitdir:")?.trim());
    let common = std::fs::read_to_string(gitdir.join("commondir")).ok()?;
    let common = std::fs::canonicalize(gitdir.join(common.trim())).ok()?;
    if common.file_name()? != ".git" {
        return None;
    }
    common.parent().map(Path::to_path_buf)
}

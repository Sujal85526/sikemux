//! The signed footer naming the agents whose lines a commit holds, for every
//! way a commit is made here: the git panel, `git_commit`, Auto, and an
//! agent's own `git commit` through the git shim.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Deserialize;
use serde_json::Value;

use super::owners::{git, latest, run, staged_in, Author};
use crate::cli::protocol::HarnessRequest;
use crate::server::connection::blocking;
use crate::server::names::project_of;
use crate::server::Core;
use crate::trailers::{self, Agent, Commit};

/// The footer for committing what `dir` has staged, or what `index` holds when
/// git commits from an index of its own: every agent whose lines it holds,
/// else `fallback`. An `amend` keeps the agents of the commit it replaces.
pub(crate) fn footer(
    core: &Core,
    dir: &Path,
    fallback: Option<&str>,
    index: Option<&Path>,
    amend: bool,
) -> Result<Vec<String>, String> {
    let ((owners, base), (tree, parents)) = std::thread::scope(|scope| {
        let made_of = scope.spawn(|| made_of(dir, index, amend));
        let owners = staged_in(core, dir, index);
        let made_of = made_of
            .join()
            .unwrap_or_else(|_| Err("git did not run".to_owned()));
        owners.and_then(|owners| Ok((owners, made_of?)))
    })?;
    let mut agents = if amend {
        verified(core, dir, "HEAD")?
    } else {
        Vec::new()
    };
    for author in owners.writers() {
        if !agents.iter().any(|agent| agent.chat == author.agent_id) {
            agents.push(agent(core, author));
        }
    }
    if agents.is_empty() {
        agents.extend(fallback.and_then(|id| known(core, dir, id)));
    }
    let parents = match (amend, base) {
        (false, Some(base)) => std::iter::once(base).chain(parents).collect(),
        _ => parents,
    };
    let commit = Commit {
        tree: &tree,
        parents: &parents,
    };
    Ok(trailers::footer(
        &agents,
        &commit,
        core.remote.host_key().as_ref(),
    ))
}

/// The tree `index` makes, and the parents a commit of it takes besides
/// `HEAD`: those of `HEAD` when amending it, else those of a merge underway.
fn made_of(dir: &Path, index: Option<&Path>, amend: bool) -> Result<(String, Vec<String>), String> {
    let text = |out: Vec<u8>| String::from_utf8_lossy(&out).trim().to_owned();
    let tree = text(run(dir, &["write-tree"], index, None)?);
    let parents = if amend {
        git(dir, &["rev-parse", "HEAD^@"])?
            .lines()
            .map(str::to_owned)
            .collect()
    } else {
        let merging = git(
            dir,
            &[
                "rev-parse",
                "--path-format=absolute",
                "--git-path",
                "MERGE_HEAD",
            ],
        )?;
        std::fs::read_to_string(merging.trim())
            .unwrap_or_default()
            .split_whitespace()
            .map(str::to_owned)
            .collect()
    };
    Ok((tree, parents))
}

/// `author` as it is now: the CLI's version and the model of its open chat,
/// else the model of its latest edit, and the Sikemux it runs in.
pub(super) fn agent(core: &Core, author: &Author) -> Agent {
    let chat = core.chats.get(&author.agent_id);
    Agent {
        name: author.name.clone(),
        cli: author.cli.clone(),
        cli_version: chat.as_ref().and_then(|chat| chat.cli_version()),
        model: chat
            .and_then(|chat| chat.current_launch().model)
            .or_else(|| author.model.clone()),
        sikemux: Some(core.build.version.clone()),
        chat: author.agent_id.clone(),
    }
}

/// `agent_id` as its latest edit in `dir`'s project names it, else as the
/// chat or terminal it runs in does.
pub(super) fn known(core: &Core, dir: &Path, agent_id: &str) -> Option<Agent> {
    if let Some(author) = latest(core, dir, agent_id) {
        return Some(agent(core, &author));
    }
    let chat = core.chats.get(agent_id);
    let cli = match &chat {
        Some(chat) => chat.provider().to_owned(),
        None => core.all_sessions().iter().find_map(|session| {
            let owner = session.owner();
            (owner.agent_id.as_deref() == Some(agent_id))
                .then(|| owner.agent_type.clone())
                .flatten()
        })?,
    };
    let name = core.names.name(agent_id).unwrap_or_else(|| cli.clone());
    Some(Agent {
        name,
        cli,
        cli_version: chat.as_ref().and_then(|chat| chat.cli_version()),
        model: chat.and_then(|chat| chat.current_launch().model),
        sikemux: Some(core.build.version.clone()),
        chat: agent_id.to_owned(),
    })
}

/// The agents `commit`'s footer names, when it checks out: signed by this
/// host or one linked with it, over the commit's own tree and parents, and
/// naming only chats this host recorded. Anything else is text anyone could
/// have written.
pub(crate) fn verified(core: &Core, dir: &Path, commit: &str) -> Result<Vec<Agent>, String> {
    let object = git(dir, &["cat-file", "commit", commit])?;
    let (header, message) = object.split_once("\n\n").unwrap_or((&object, ""));
    let mut tree = String::new();
    let mut parents = Vec::new();
    for line in header.lines() {
        match line.split_once(' ') {
            Some(("tree", id)) => tree = id.to_owned(),
            Some(("parent", id)) => parents.push(id.to_owned()),
            _ => {}
        }
    }
    let commit = Commit {
        tree: &tree,
        parents: &parents,
    };
    let Some((_, agents)) = trailers::verify(message, &commit, &core.remote.host_keys()) else {
        return Ok(Vec::new());
    };
    let project = project_of(dir, &core.workspaces.project_paths());
    Ok(agents
        .into_iter()
        .filter(|agent| recorded(core, &project, &agent.chat))
        .collect())
}

fn recorded(core: &Core, project: &str, chat: &str) -> bool {
    core.names.name(chat).is_some()
        || core.names.ran_session(chat).is_some()
        || !core
            .edits
            .matching(project, |edit| edit.agent_id == chat)
            .is_empty()
}

#[derive(Deserialize)]
struct Pending {
    /// The index git commits from, when not the checkout's own.
    #[serde(default)]
    index: Option<PathBuf>,
    #[serde(default)]
    amend: bool,
}

/// The footer for the commit an agent's `git commit` is making, which the git
/// shim asks for from the commit's hooks.
pub(crate) async fn call(core: &Arc<Core>, request: &HarnessRequest) -> Result<Value, String> {
    let agent_id = request
        .agent_id
        .clone()
        .ok_or("only an agent's commits carry a footer")?;
    let pending: Pending =
        serde_json::from_value(request.params.clone()).map_err(|error| error.to_string())?;
    let (core, dir) = (core.clone(), PathBuf::from(&request.project));
    blocking(move || {
        Ok(footer(
            &core,
            &dir,
            Some(&agent_id),
            pending.index.as_deref(),
            pending.amend,
        )?)
    })
    .await
    .map(Value::from)
    .map_err(|error| error.to_string())
}

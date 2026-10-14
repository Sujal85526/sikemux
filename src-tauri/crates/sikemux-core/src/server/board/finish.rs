//! How a card Auto runs lands: its work is committed and pushed, a pull
//! request opened, and once CI, or the project's check command when no CI
//! runs, passes, merged. A failure gets one rebase and one fix by its agent;
//! anything more goes back to the person.

use std::path::PathBuf;
use std::sync::Arc;

use super::auto::{Finish, Run, Settings, Stage};
use super::codehost::{self, Checks};
use super::{change_card, git, send_notices, By, Card, Changes, Status};
use crate::server::connection::blocking;
use crate::server::remote::unix_ms;
use crate::server::{messages, Core};

/// How long a pushed commit may go without a CI run before Auto takes it
/// that the project has none.
const CI_START_WAIT_MS: u64 = 3 * 60 * 1000;
const CHECKS_EVERY_MS: u64 = 20_000;
const REVIEW_EVERY_MS: u64 = 60_000;
const MAX_TITLE_CHARS: usize = 120;

/// Changes the card's run, if it is still `agent`'s. False when it is not.
pub(super) fn change_run(
    core: &Core,
    project: &str,
    id: u64,
    agent: &str,
    change: impl FnOnce(&mut Card, &mut Run),
) -> bool {
    let mut state = core.boards.lock();
    let Some(card) = state
        .boards
        .get_mut(project)
        .and_then(|board| board.card_mut(id).ok())
    else {
        return false;
    };
    let Some(mut run) = card
        .auto
        .take()
        .filter(|run| run.agent == agent && !run.stage.is_over())
    else {
        return false;
    };
    change(card, &mut run);
    card.auto = Some(run);
    card.updated_at = unix_ms();
    core.boards.save(&mut state, project);
    true
}

fn note(core: &Core, project: &str, id: u64, agent: &str, stage: Stage, note: &str) {
    change_run(core, project, id, agent, |_, run| {
        run.stage = stage;
        run.note = Some(note.to_owned());
    });
}

/// Gives the card back to the person, saying why. A run that never got its
/// worktree leaves the card open and nobody's, for the person to start again.
pub(crate) fn hold(core: &Core, project: &str, id: u64, agent: &str, why: String) {
    change_run(core, project, id, agent, |card, run| {
        if run.worktree.is_empty() {
            card.owner = None;
            card.owner_name = None;
            card.owner_cli = None;
            card.status = Status::Open;
        }
        run.stage = Stage::Held;
        run.note = Some(why);
    });
}

/// What a step of a run works from, read once when it starts.
#[derive(Clone)]
struct Step {
    project: String,
    id: u64,
    card: Card,
    run: Run,
    settings: Settings,
}

impl Step {
    fn tree(&self) -> PathBuf {
        PathBuf::from(&self.run.worktree)
    }

    fn agent(&self) -> &str {
        &self.run.agent
    }

    fn name(&self, core: &Core) -> String {
        core.names
            .name(self.agent())
            .or_else(|| self.card.owner_name.clone())
            .unwrap_or_else(|| "Its agent".to_owned())
    }

    fn hold(&self, core: &Core, why: String) {
        hold(core, &self.project, self.id, self.agent(), why);
    }

    fn note(&self, core: &Core, stage: Stage, text: &str) {
        note(core, &self.project, self.id, self.agent(), stage, text);
    }
}

/// Runs `work` on the card unless a step of it is under way already.
fn step<F, Fut>(core: &Arc<Core>, project: String, id: u64, stage: Option<Stage>, work: F)
where
    F: FnOnce(Arc<Core>, Step) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = ()> + Send + 'static,
{
    let step = {
        let mut state = core.boards.lock();
        let key = (project.clone(), id);
        if state.jobs.contains(&key) {
            if stage == Some(Stage::Shipping) {
                state.reship.insert(key);
            }
            return;
        }
        let Some(board) = state.boards.get_mut(&project) else {
            return;
        };
        let settings = board.settings.clone();
        let Ok(card) = board.card_mut(id) else {
            return;
        };
        let Some(run) = card.auto.as_mut().filter(|run| !run.stage.is_over()) else {
            return;
        };
        if let Some(stage) = stage {
            run.stage = stage;
        }
        let step = Step {
            project: project.clone(),
            id,
            run: run.clone(),
            card: card.clone(),
            settings,
        };
        state.jobs.insert(key);
        if stage.is_some() {
            core.boards.save(&mut state, &project);
        }
        step
    };
    let core = core.clone();
    tokio::spawn(async move {
        let key = (step.project.clone(), step.id);
        work(core.clone(), step).await;
        let again = {
            let mut state = core.boards.lock();
            state.jobs.remove(&key);
            state.reship.remove(&key)
        };
        if again {
            ship(&core, key.0, key.1);
        }
    });
}

/// Starts a card Auto gave back to the person again: from the start when it
/// never got a worktree, else by shipping its work afresh.
pub(super) fn retry(core: &Arc<Core>, project: &str, id: u64) -> Result<(), String> {
    let ships = {
        let mut state = core.boards.lock();
        let card = state
            .boards
            .get_mut(project)
            .ok_or_else(|| format!("There is no card #{id} on this project's board"))?
            .card_mut(id)?;
        let run = card
            .auto
            .as_mut()
            .filter(|run| matches!(run.stage, Stage::Held | Stage::Review))
            .ok_or("Auto has not given that card back to you")?;
        let ships = !run.worktree.is_empty();
        if ships {
            run.rebased = false;
            run.fixed = false;
        } else {
            card.auto = None;
        }
        card.updated_at = unix_ms();
        core.boards.save(&mut state, project);
        ships
    };
    if ships {
        ship(core, project.to_owned(), id);
    }
    Ok(())
}

/// Ships the card's work: commit, push, pull request, then its checks.
pub(super) fn ship(core: &Arc<Core>, project: String, id: u64) {
    step(
        core,
        project,
        id,
        Some(Stage::Shipping),
        |core, step| async move {
            step.note(&core, Stage::Shipping, "Committing and pushing its work");
            if let Err(why) = shipping(&core, &step).await {
                step.hold(&core, why);
            }
        },
    );
}

fn commit_message(card: &Card) -> String {
    let title: String = card.title.chars().take(MAX_TITLE_CHARS).collect();
    let mut message = title;
    if let Some(ticket) = &card.ticket {
        message.push_str(&format!("\n\n{}", ticket.key));
    }
    message
}

fn pull_body(core: &Core, step: &Step) -> String {
    let card = &step.card;
    let mut body = String::new();
    if !card.details.is_empty() {
        body.push_str(&card.details);
        body.push_str("\n\n");
    }
    if let Some(result) = current_result(core, step) {
        body.push_str(&result);
        body.push_str("\n\n");
    }
    if let Some(ticket) = &card.ticket {
        match &ticket.url {
            Some(url) => body.push_str(&format!("Ticket: [{}]({url})\n\n", ticket.key)),
            None => body.push_str(&format!("Ticket: {}\n\n", ticket.key)),
        }
    }
    body.push_str(&format!(
        "Done by {} for card #{} of the board, opened by Sikemux's Auto.",
        step.name(core),
        card.id
    ));
    body
}

fn current_result(core: &Core, step: &Step) -> Option<String> {
    let state = core.boards.lock();
    state
        .boards
        .get(&step.project)?
        .card(step.id)
        .ok()?
        .result
        .clone()
}

async fn shipping(core: &Arc<Core>, step: &Step) -> Result<(), String> {
    let tree = step.tree();
    let repo = PathBuf::from(&step.run.repo);
    let message = commit_message(&step.card);
    let start = step.run.start_sha.clone();
    let (ahead, origin) = {
        let (tree, repo) = (tree.clone(), repo.clone());
        blocking(move || {
            git::commit_all(&tree, &message)?;
            let ahead = git::ahead(&tree, &start)?;
            Ok((ahead, git::origin(&repo)))
        })
        .await
        .map_err(|error| error.to_string())?
    };
    if ahead == 0 {
        return Err(format!(
            "{} finished without a change to merge; read its answer and mark the card done or move it back to Open",
            step.name(core)
        ));
    }
    let origin = origin.ok_or("the project has no origin remote to open a pull request on")?;
    let host = codehost::find(&origin).await?;
    let (branch, replace) = (step.run.branch.clone(), step.run.rebased);
    let head = {
        let tree = tree.clone();
        blocking(move || {
            git::push(&tree, &branch, replace)?;
            git::head(&tree).map_err(Into::into)
        })
        .await
        .map_err(|error| format!("the push failed: {error}"))?
    };
    let pull = match &step.run.pull {
        Some(pull) => pull.clone(),
        None => codehost::open(
            &host,
            &step.card.title,
            &step.run.branch,
            &step.run.base,
            &pull_body(core, step),
        )
        .await
        .map_err(|error| format!("the pull request did not open: {error}"))?,
    };
    let stop = if step.settings.finish == Finish::Pr {
        Some("Its pull request waits for you to review and merge it".to_owned())
    } else if core.harness.questions.has_open(step.agent()) {
        Some(format!(
            "{} has a question or an assumption you have not answered, so its pull request waits for you",
            step.name(core)
        ))
    } else {
        None
    };
    let now = unix_ms();
    change_run(core, &step.project, step.id, step.agent(), |_, run| {
        run.pull = Some(pull);
        run.head = Some(head);
        run.checks_since = Some(now);
        match stop {
            Some(why) => {
                run.stage = Stage::Review;
                run.note = Some(why);
            }
            None => {
                run.stage = Stage::Checking;
                run.note = Some("Waiting for its checks".to_owned());
            }
        }
    });
    Ok(())
}

/// Looks at the checks of runs waiting on them, at pull requests waiting on
/// the person, and takes up steps a restart cut short.
pub(super) fn tick(core: &Arc<Core>) {
    let now = unix_ms();
    let due: Vec<(String, u64, Stage)> = {
        let mut state = core.boards.lock();
        let mut due = Vec::new();
        for (project, board) in &state.boards {
            for card in &board.cards {
                let Some(run) = &card.auto else { continue };
                if state.jobs.contains(&(project.clone(), card.id)) {
                    continue;
                }
                let every = match run.stage {
                    Stage::Checking => CHECKS_EVERY_MS,
                    Stage::Review => REVIEW_EVERY_MS,
                    Stage::Shipping | Stage::Merging | Stage::Starting => 0,
                    _ => continue,
                };
                let last = state
                    .polled
                    .get(&(project.clone(), card.id, "pull"))
                    .copied()
                    .unwrap_or(0);
                if every > 0 && now.saturating_sub(last) < every {
                    continue;
                }
                due.push((project.clone(), card.id, run.stage));
            }
        }
        for (project, id, _) in &due {
            state.polled.insert((project.clone(), *id, "pull"), now);
        }
        due
    };
    for (project, id, stage) in due {
        match stage {
            Stage::Checking | Stage::Merging => {
                step(core, project, id, None, |core, step| async move {
                    checking(&core, step).await;
                })
            }
            Stage::Review => step(core, project, id, None, |core, step| async move {
                reviewing(&core, step).await;
            }),
            Stage::Shipping => ship(core, project, id),
            Stage::Starting => step(core, project, id, None, |core, step| async move {
                step.hold(
                    &core,
                    "Sikemux's background process restarted while Auto was starting it".to_owned(),
                );
            }),
            _ => {}
        }
    }
}

async fn checking(core: &Arc<Core>, step: Step) {
    let (Some(pull), Some(head)) = (step.run.pull.clone(), step.run.head.clone()) else {
        ship(core, step.project.clone(), step.id);
        return;
    };
    let checks = match codehost::checks(&pull, &step.run.branch, &head).await {
        Ok(checks) => checks,
        Err(error) => {
            step.note(
                core,
                Stage::Checking,
                &format!("Could not read its checks: {error}"),
            );
            return;
        }
    };
    let waited = unix_ms().saturating_sub(step.run.checks_since.unwrap_or(0));
    match checks {
        Checks::Running => step.note(core, Stage::Checking, "Its checks are running"),
        Checks::Passed => merge(core, &step, &pull, &head).await,
        Checks::Failed(what) => failed(core, &step, &what).await,
        Checks::None if waited < CI_START_WAIT_MS => {
            step.note(core, Stage::Checking, "Waiting for its checks to start");
        }
        Checks::None => match step.settings.check.clone() {
            Some(command) => {
                step.note(core, Stage::Checking, &format!("Running {command}"));
                let cwd = step.tree();
                let checked = blocking(move || git::check(&cwd, &command).map_err(Into::into)).await;
                match checked {
                    Ok((true, _)) => merge(core, &step, &pull, &head).await,
                    Ok((false, output)) => {
                        failed(core, &step, &format!("The check command failed:\n{output}")).await;
                    }
                    Err(error) => step.hold(core, format!("The check command did not run: {error}")),
                }
            }
            None => step.note(
                core,
                Stage::Review,
                "No CI ran on its pull request and this project has no check command, so it waits for you",
            ),
        },
    }
}

/// The checks failed: the agent gets one go at fixing them.
async fn failed(core: &Arc<Core>, step: &Step, what: &str) {
    if step.run.fixed {
        step.hold(
            core,
            format!("Its checks failed again after a fix:\n{}", git::tail(what)),
        );
        return;
    }
    let url = step
        .run
        .pull
        .as_ref()
        .map(|pull| pull.url.clone())
        .unwrap_or_default();
    let text = format!(
        "The checks on your pull request {url} failed:\n\n{}\n\nFix them on {} and commit. When your turn ends, Sikemux pushes and checks again. This is the one fix Auto asks for: if they fail again, the card goes back to the person.",
        git::tail(what),
        step.run.branch
    );
    ask_fix(core, step, text, "Its checks failed, so it is fixing them").await;
}

async fn ask_fix(core: &Arc<Core>, step: &Step, text: String, note: &str) {
    let name = step.name(core);
    change_run(core, &step.project, step.id, step.agent(), |_, run| {
        run.fixed = true;
        run.stage = Stage::Fixing;
        run.note = Some(note.to_owned());
    });
    if let Err(error) = messages::from_auto(core, step.agent().to_owned(), text).await {
        step.hold(
            core,
            format!("{name} could not be asked to fix it: {error}"),
        );
    }
}

async fn merge(core: &Arc<Core>, step: &Step, pull: &super::auto::Pull, head: &str) {
    step.note(core, Stage::Merging, "Merging its pull request");
    let error = match codehost::merge(pull, head).await {
        Ok(()) => return merged(core, step).await,
        Err(error) => error,
    };
    if matches!(codehost::state(pull).await.as_deref(), Ok("merged")) {
        return merged(core, step).await;
    }
    if step.run.rebased {
        step.hold(core, format!("Its pull request did not merge: {error}"));
        return;
    }
    let (tree, base, branch) = (step.tree(), step.run.base.clone(), step.run.branch.clone());
    let rebased = blocking(move || {
        if !git::rebase(&tree, &base)? {
            return Ok(None);
        }
        git::push(&tree, &branch, true)?;
        git::head(&tree).map(Some).map_err(Into::into)
    })
    .await;
    match rebased {
        Ok(Some(head)) => {
            let now = unix_ms();
            change_run(core, &step.project, step.id, step.agent(), |_, run| {
                run.rebased = true;
                run.head = Some(head);
                run.checks_since = Some(now);
                run.stage = Stage::Checking;
                run.note = Some(format!(
                    "It did not merge, so Auto put it on the latest {} and waits for its checks again",
                    run.base
                ));
            });
        }
        Ok(None) if !step.run.fixed => {
            let text = format!(
                "Your pull request did not merge ({error}), and {} does not rebase cleanly onto origin/{}. Rebase it onto origin/{}, resolve the conflicts, run the checks and commit. When your turn ends, Sikemux pushes and checks again. This is the one fix Auto asks for.",
                step.run.branch, step.run.base, step.run.base
            );
            ask_fix(
                core,
                step,
                text,
                "It conflicts with the latest base, so it is rebasing",
            )
            .await;
        }
        Ok(None) => step.hold(
            core,
            format!(
                "It did not merge and conflicts with the latest {}: {error}",
                step.run.base
            ),
        ),
        Err(failure) => step.hold(
            core,
            format!("It did not merge ({error}), and rebasing it failed: {failure}"),
        ),
    }
}

/// Its pull request merged: the card is done, its agent stops and its
/// worktree goes.
async fn merged(core: &Arc<Core>, step: &Step) {
    let url = step
        .run
        .pull
        .as_ref()
        .map(|pull| pull.url.clone())
        .unwrap_or_default();
    let kept = change_run(core, &step.project, step.id, step.agent(), |_, run| {
        run.stage = Stage::Merged;
        run.note = Some("Merged".to_owned());
    });
    if !kept {
        return;
    }
    let result = match current_result(core, step) {
        Some(result) if !result.contains(&url) => format!("{result}\n\nMerged in {url}"),
        Some(result) => result,
        None => format!("Merged in {url}"),
    };
    let changes = Changes {
        status: Some(Status::Done),
        result: Some(result),
        ..Changes::default()
    };
    let (core2, project, id) = (core.clone(), step.project.clone(), step.id);
    let notices = blocking(move || {
        change_card(&core2, &project, &By::Auto("Auto"), id, changes)
            .map(|(_, notices)| notices)
            .map_err(Into::into)
    })
    .await
    .unwrap_or_default();
    send_notices(core, notices);
    if core.chats.stop(step.agent()) {
        core.note_agent_gone(step.agent());
    }
    let (repo, tree, branch) = (
        PathBuf::from(&step.run.repo),
        step.tree(),
        step.run.branch.clone(),
    );
    let _ = blocking(move || {
        git::remove_worktree(&repo, &tree, &branch);
        Ok(())
    })
    .await;
}

/// A pull request left for the person: merged by them closes the card,
/// closed without merging hands it back.
async fn reviewing(core: &Arc<Core>, step: Step) {
    let Some(pull) = step.run.pull.clone() else {
        return;
    };
    match codehost::state(&pull).await.as_deref() {
        Ok("merged") => merged(core, &step).await,
        Ok("closed" | "declined" | "superseded") => {
            step.hold(
                core,
                "Its pull request was closed without merging".to_owned(),
            );
        }
        _ => {}
    }
}

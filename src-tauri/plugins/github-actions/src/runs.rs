// Workflow runs, the jobs inside one, and the buttons that re-run or stop
// them. Times are passed through as GitHub wrote them, so whoever shows them
// decides how to phrase "3 minutes ago".

use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::client;
use crate::error::{ActionsError, ActionsResult};
use crate::workflows::RepoRef;

const DEFAULT_PER_PAGE: u32 = 30;
const MAX_PER_PAGE: u32 = 100;

#[derive(Deserialize)]
struct Actor {
    login: String,
    avatar_url: Option<String>,
}

#[derive(Deserialize)]
struct PullRequestRef {
    number: u64,
}

#[derive(Deserialize)]
struct RunRow {
    id: u64,
    name: Option<String>,
    display_title: Option<String>,
    workflow_id: u64,
    run_number: u64,
    run_attempt: Option<u64>,
    event: String,
    status: Option<String>,
    conclusion: Option<String>,
    head_branch: Option<String>,
    head_sha: String,
    html_url: String,
    created_at: String,
    updated_at: String,
    run_started_at: Option<String>,
    actor: Option<Actor>,
    triggering_actor: Option<Actor>,
    #[serde(default)]
    pull_requests: Vec<PullRequestRef>,
}

#[derive(Deserialize)]
struct RunList {
    total_count: u64,
    workflow_runs: Vec<RunRow>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub id: u64,
    pub name: String,
    pub title: String,
    pub workflow_id: u64,
    pub run_number: u64,
    pub attempt: u64,
    pub event: String,
    /// `queued`, `in_progress`, `completed`, and the waiting-for-approval ones.
    pub status: String,
    /// Only set once the run is over: `success`, `failure`, `cancelled`, and the rest.
    pub conclusion: Option<String>,
    pub branch: Option<String>,
    pub sha: String,
    pub short_sha: String,
    pub actor: Option<String>,
    pub avatar_url: Option<String>,
    pub created_at: String,
    pub started_at: Option<String>,
    pub updated_at: String,
    pub pull_requests: Vec<u64>,
    pub url: String,
}

/// A run is over once GitHub says it is completed; everything else is still moving.
pub fn is_finished(status: &str) -> bool {
    status == "completed"
}

fn short(sha: &str) -> String {
    sha.chars().take(7).collect()
}

impl From<RunRow> for Run {
    fn from(row: RunRow) -> Self {
        let actor = row.triggering_actor.or(row.actor);
        Self {
            title: row
                .display_title
                .clone()
                .or_else(|| row.name.clone())
                .unwrap_or_default(),
            name: row.name.unwrap_or_default(),
            short_sha: short(&row.head_sha),
            id: row.id,
            workflow_id: row.workflow_id,
            run_number: row.run_number,
            attempt: row.run_attempt.unwrap_or(1),
            event: row.event,
            status: row.status.unwrap_or_else(|| "queued".into()),
            conclusion: row.conclusion,
            branch: row.head_branch,
            sha: row.head_sha,
            actor: actor.as_ref().map(|actor| actor.login.clone()),
            avatar_url: actor.and_then(|actor| actor.avatar_url),
            created_at: row.created_at,
            started_at: row.run_started_at,
            updated_at: row.updated_at,
            pull_requests: row
                .pull_requests
                .into_iter()
                .map(|pull| pull.number)
                .collect(),
            url: row.html_url,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunQuery {
    #[serde(flatten)]
    pub repo: RepoRef,
    pub workflow_id: Option<u64>,
    pub branch: Option<String>,
    /// One of GitHub's run statuses or conclusions, which it filters by interchangeably.
    pub status: Option<String>,
    pub event: Option<String>,
    pub actor: Option<String>,
    pub page: Option<u32>,
    pub per_page: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunPage {
    pub runs: Vec<Run>,
    pub total: u64,
    pub next_page: Option<u32>,
}

/// Filters only ever reach GitHub as query values it recognises, so a typed
/// one that is not a status is dropped rather than sent.
const STATUSES: [&str; 13] = [
    "queued",
    "in_progress",
    "completed",
    "requested",
    "waiting",
    "pending",
    "success",
    "failure",
    "neutral",
    "cancelled",
    "skipped",
    "timed_out",
    "action_required",
];

fn known_status(value: &str) -> bool {
    STATUSES.contains(&value)
}

pub async fn list(data_dir: &Path, input: RunQuery) -> ActionsResult<RunPage> {
    let per_page = input
        .per_page
        .unwrap_or(DEFAULT_PER_PAGE)
        .clamp(1, MAX_PER_PAGE);
    let page = input.page.unwrap_or(1).max(1);
    let mut query = vec![
        ("per_page", per_page.to_string()),
        ("page", page.to_string()),
    ];
    if let Some(branch) = input
        .branch
        .as_deref()
        .map(str::trim)
        .filter(|b| !b.is_empty())
    {
        query.push(("branch", branch.to_string()));
    }
    if let Some(status) = input
        .status
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        if !known_status(status) {
            return Err(ActionsError::BadArg(format!(
                "`{status}` is not a run status"
            )));
        }
        query.push(("status", status.to_string()));
    }
    if let Some(event) = input
        .event
        .as_deref()
        .map(str::trim)
        .filter(|e| !e.is_empty())
    {
        query.push(("event", event.to_string()));
    }
    if let Some(actor) = input
        .actor
        .as_deref()
        .map(str::trim)
        .filter(|a| !a.is_empty())
    {
        query.push(("actor", actor.to_string()));
    }
    let path = match input.workflow_id {
        Some(id) => input.repo.path(&format!("/actions/workflows/{id}/runs"))?,
        None => input.repo.path("/actions/runs")?,
    };
    let list: RunList = client::get(data_dir, &path, &query).await?;
    let runs: Vec<Run> = list.workflow_runs.into_iter().map(Run::from).collect();
    let seen = u64::from(page.saturating_sub(1)) * u64::from(per_page) + runs.len() as u64;
    Ok(RunPage {
        next_page: (seen < list.total_count && !runs.is_empty()).then(|| page + 1),
        total: list.total_count,
        runs,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRef {
    #[serde(flatten)]
    pub repo: RepoRef,
    pub run_id: u64,
}

pub async fn get(data_dir: &Path, input: RunRef) -> ActionsResult<Run> {
    let path = input
        .repo
        .path(&format!("/actions/runs/{}", input.run_id))?;
    let row: RunRow = client::get(data_dir, &path, &[]).await?;
    Ok(Run::from(row))
}

#[derive(Deserialize)]
struct StepRow {
    name: String,
    status: Option<String>,
    conclusion: Option<String>,
    number: u64,
    started_at: Option<String>,
    completed_at: Option<String>,
}

#[derive(Deserialize)]
struct JobRow {
    id: u64,
    name: String,
    status: Option<String>,
    conclusion: Option<String>,
    started_at: Option<String>,
    completed_at: Option<String>,
    html_url: Option<String>,
    runner_name: Option<String>,
    #[serde(default)]
    steps: Vec<StepRow>,
}

#[derive(Deserialize)]
struct JobList {
    jobs: Vec<JobRow>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub number: u64,
    pub name: String,
    pub status: String,
    pub conclusion: Option<String>,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: u64,
    pub name: String,
    pub status: String,
    pub conclusion: Option<String>,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub runner: Option<String>,
    pub url: Option<String>,
    pub steps: Vec<Step>,
}

impl From<JobRow> for Job {
    fn from(row: JobRow) -> Self {
        Self {
            id: row.id,
            name: row.name,
            status: row.status.unwrap_or_else(|| "queued".into()),
            conclusion: row.conclusion,
            started_at: row.started_at,
            completed_at: row.completed_at,
            runner: row.runner_name,
            url: row.html_url,
            steps: row
                .steps
                .into_iter()
                .map(|step| Step {
                    number: step.number,
                    name: step.name,
                    status: step.status.unwrap_or_else(|| "queued".into()),
                    conclusion: step.conclusion,
                    started_at: step.started_at,
                    completed_at: step.completed_at,
                })
                .collect(),
        }
    }
}

pub async fn jobs(data_dir: &Path, input: RunRef) -> ActionsResult<Vec<Job>> {
    let path = input
        .repo
        .path(&format!("/actions/runs/{}/jobs", input.run_id))?;
    let list: JobList = client::get(
        data_dir,
        &path,
        &[
            ("per_page", MAX_PER_PAGE.to_string()),
            ("filter", "latest".to_string()),
        ],
    )
    .await?;
    Ok(list.jobs.into_iter().map(Job::from).collect())
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RunDetail {
    pub run: Run,
    pub jobs: Vec<Job>,
}

pub async fn detail(data_dir: &Path, input: RunRef) -> ActionsResult<RunDetail> {
    let repo = RepoRef {
        owner: input.repo.owner.clone(),
        name: input.repo.name.clone(),
    };
    let run_id = input.run_id;
    let (run, jobs) = futures::future::join(
        get(data_dir, input),
        jobs(data_dir, RunRef { repo, run_id }),
    )
    .await;
    Ok(RunDetail {
        run: run?,
        jobs: jobs?,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rerun {
    #[serde(flatten)]
    pub run: RunRef,
    /// Re-run only the jobs that did not pass, rather than the whole run.
    #[serde(default)]
    pub failed_only: bool,
}

pub async fn rerun(data_dir: &Path, input: Rerun) -> ActionsResult<()> {
    let tail = if input.failed_only {
        "rerun-failed-jobs"
    } else {
        "rerun"
    };
    let path = input
        .run
        .repo
        .path(&format!("/actions/runs/{}/{tail}", input.run.run_id))?;
    client::post_empty(data_dir, &path, None).await
}

pub async fn cancel(data_dir: &Path, input: RunRef) -> ActionsResult<()> {
    let path = input
        .repo
        .path(&format!("/actions/runs/{}/cancel", input.run_id))?;
    client::post_empty(data_dir, &path, None).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobRef {
    #[serde(flatten)]
    pub repo: RepoRef,
    pub job_id: u64,
}

pub async fn rerun_job(data_dir: &Path, input: JobRef) -> ActionsResult<()> {
    let path = input
        .repo
        .path(&format!("/actions/jobs/{}/rerun", input.job_id))?;
    client::post_empty(
        data_dir,
        &path,
        Some(&json!({ "enable_debug_logging": false })),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shortens_a_sha_the_way_git_does() {
        assert_eq!(short("b8feb3812345"), "b8feb38");
        assert_eq!(short("abc"), "abc");
        assert_eq!(short(""), "");
    }

    #[test]
    fn only_a_completed_run_is_finished() {
        assert!(is_finished("completed"));
        for moving in ["queued", "in_progress", "waiting", "requested", "pending"] {
            assert!(!is_finished(moving), "{moving}");
        }
    }

    #[test]
    fn knows_the_statuses_github_filters_by() {
        assert!(known_status("in_progress"));
        assert!(known_status("timed_out"));
        assert!(!known_status("exploded"));
        assert!(!known_status(""));
    }

    #[test]
    fn a_run_falls_back_to_its_workflow_name_for_a_title() {
        let row: RunRow = serde_json::from_value(json!({
            "id": 1, "name": "CI", "display_title": null, "workflow_id": 9,
            "run_number": 4, "event": "push", "status": "completed", "conclusion": "success",
            "head_sha": "deadbeefcafe", "html_url": "https://example.com",
            "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:01:00Z",
        }))
        .expect("a run parses");
        let run = Run::from(row);
        assert_eq!(run.title, "CI");
        assert_eq!(run.short_sha, "deadbee");
        assert_eq!(run.attempt, 1);
        assert!(run.pull_requests.is_empty());
    }

    #[test]
    fn the_person_who_set_a_run_going_wins_over_its_owner() {
        let row: RunRow = serde_json::from_value(json!({
            "id": 1, "workflow_id": 9, "run_number": 4, "event": "push",
            "status": "queued", "head_sha": "abc", "html_url": "https://example.com",
            "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z",
            "actor": { "login": "owner", "avatar_url": null },
            "triggering_actor": { "login": "rerunner", "avatar_url": "https://avatar" },
        }))
        .expect("a run parses");
        let run = Run::from(row);
        assert_eq!(run.actor.as_deref(), Some("rerunner"));
        assert_eq!(run.avatar_url.as_deref(), Some("https://avatar"));
    }
}

// Issues: the list, one of them, and closing or reopening it. GitHub returns
// pull requests from the issues endpoint too, which is never what the issues
// list is meant to show.

use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::client;
use crate::common::{avatar_of, login_of, ActorRow, Label, LabelRow, MAX_PER_PAGE};
use crate::error::{ActionsError, ActionsResult};
use crate::workflows::RepoRef;

const DEFAULT_PER_PAGE: u32 = 30;
const STATES: [&str; 3] = ["open", "closed", "all"];

#[derive(Deserialize)]
struct IssueRow {
    number: u64,
    title: String,
    body: Option<String>,
    state: String,
    user: Option<ActorRow>,
    created_at: String,
    updated_at: String,
    closed_at: Option<String>,
    comments: Option<u64>,
    html_url: String,
    #[serde(default)]
    labels: Vec<LabelRow>,
    #[serde(default)]
    assignees: Vec<ActorRow>,
    /// Present only when the row is really a pull request.
    pull_request: Option<Value>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub number: u64,
    pub title: String,
    pub body: String,
    pub state: String,
    pub author: Option<String>,
    pub avatar_url: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub closed_at: Option<String>,
    pub comments: u64,
    pub labels: Vec<Label>,
    pub assignees: Vec<String>,
    pub url: String,
}

impl From<IssueRow> for Issue {
    fn from(row: IssueRow) -> Self {
        Self {
            number: row.number,
            title: row.title,
            body: row.body.unwrap_or_default(),
            state: row.state,
            author: login_of(&row.user),
            avatar_url: avatar_of(&row.user),
            created_at: row.created_at,
            updated_at: row.updated_at,
            closed_at: row.closed_at,
            comments: row.comments.unwrap_or(0),
            labels: row.labels.into_iter().map(Label::from).collect(),
            assignees: row.assignees.into_iter().map(|actor| actor.login).collect(),
            url: row.html_url,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Query {
    #[serde(flatten)]
    pub repo: RepoRef,
    pub state: Option<String>,
    /// A GitHub login, or `@me` for whoever is signed in.
    pub assignee: Option<String>,
    pub labels: Option<String>,
    pub page: Option<u32>,
    pub per_page: Option<u32>,
}

pub async fn list(data_dir: &Path, input: Query) -> ActionsResult<Vec<Issue>> {
    let state = input.state.unwrap_or_else(|| "open".into());
    if !STATES.contains(&state.as_str()) {
        return Err(ActionsError::BadArg(format!(
            "`{state}` is not open, closed or all"
        )));
    }
    let mut query = vec![
        ("state", state),
        ("sort", "updated".to_string()),
        ("direction", "desc".to_string()),
        (
            "per_page",
            input
                .per_page
                .unwrap_or(DEFAULT_PER_PAGE)
                .clamp(1, MAX_PER_PAGE)
                .to_string(),
        ),
        ("page", input.page.unwrap_or(1).max(1).to_string()),
    ];
    if let Some(assignee) = input
        .assignee
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        query.push(("assignee", assignee.to_string()));
    }
    if let Some(labels) = input
        .labels
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        query.push(("labels", labels.to_string()));
    }
    let rows: Vec<IssueRow> = client::get(data_dir, &input.repo.path("/issues")?, &query).await?;
    Ok(rows
        .into_iter()
        .filter(|row| row.pull_request.is_none())
        .map(Issue::from)
        .collect())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueRef {
    #[serde(flatten)]
    pub repo: RepoRef,
    pub number: u64,
}

pub async fn get(data_dir: &Path, input: IssueRef) -> ActionsResult<Issue> {
    let path = input.repo.path(&format!("/issues/{}", input.number))?;
    let row: IssueRow = client::get(data_dir, &path, &[]).await?;
    Ok(Issue::from(row))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetState {
    #[serde(flatten)]
    pub issue: IssueRef,
    /// `open` or `closed`.
    pub state: String,
}

pub async fn set_state(data_dir: &Path, input: SetState) -> ActionsResult<()> {
    if !matches!(input.state.as_str(), "open" | "closed") {
        return Err(ActionsError::BadArg(format!(
            "`{}` is not open or closed",
            input.state
        )));
    }
    let path = input
        .issue
        .repo
        .path(&format!("/issues/{}", input.issue.number))?;
    let body = json!({ "state": input.state });
    client::act(data_dir, reqwest::Method::PATCH, &path, Some(&body)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rows() -> Vec<IssueRow> {
        serde_json::from_value(json!([
            {
                "number": 1, "title": "A real issue", "state": "open",
                "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z",
                "html_url": "https://github.com/a/b/issues/1",
            },
            {
                "number": 2, "title": "Actually a pull request", "state": "open",
                "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z",
                "html_url": "https://github.com/a/b/pull/2",
                "pull_request": { "url": "https://api.github.com/repos/a/b/pulls/2" },
            },
        ]))
        .expect("parses")
    }

    #[test]
    fn the_issues_list_leaves_out_the_pull_requests_github_mixes_in() {
        let kept: Vec<u64> = rows()
            .into_iter()
            .filter(|row| row.pull_request.is_none())
            .map(|row| row.number)
            .collect();
        assert_eq!(kept, [1]);
    }

    #[test]
    fn reads_labels_and_assignees() {
        let row: IssueRow = serde_json::from_value(json!({
            "number": 3, "title": "Crash on open", "state": "open",
            "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z",
            "html_url": "https://github.com/a/b/issues/3",
            "labels": [{ "name": "bug", "color": "d73a4a" }],
            "assignees": [{ "login": "nodelike" }],
            "comments": 4,
        }))
        .expect("parses");
        let issue = Issue::from(row);
        assert_eq!(issue.labels.first().map(|l| l.name.as_str()), Some("bug"));
        assert_eq!(issue.assignees, ["nodelike"]);
        assert_eq!(issue.comments, 4);
    }

    #[tokio::test]
    async fn refuses_a_state_github_would_not_take() {
        let repo = RepoRef {
            owner: "a".into(),
            name: "b".into(),
        };
        let bad = SetState {
            issue: IssueRef { repo, number: 1 },
            state: "archived".into(),
        };
        assert!(set_state(&std::env::temp_dir(), bad).await.is_err());
    }
}

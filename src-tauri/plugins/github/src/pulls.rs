// Pull requests: the list, one of them in full, the files it touches, and
// merging it. A pull request is also an issue in GitHub's API, so its comments
// come from there.

use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::client;
use crate::common::{avatar_of, login_of, ActorRow, Label, LabelRow, MAX_PER_PAGE};
use crate::error::{ActionsError, ActionsResult};
use crate::workflows::RepoRef;

const DEFAULT_PER_PAGE: u32 = 30;

#[derive(Deserialize)]
struct BranchSide {
    #[serde(rename = "ref")]
    name: String,
}

#[derive(Deserialize)]
struct PullRow {
    number: u64,
    title: String,
    body: Option<String>,
    state: String,
    draft: Option<bool>,
    merged: Option<bool>,
    merged_at: Option<String>,
    user: Option<ActorRow>,
    head: Option<BranchSide>,
    base: Option<BranchSide>,
    created_at: String,
    updated_at: String,
    comments: Option<u64>,
    additions: Option<u64>,
    deletions: Option<u64>,
    changed_files: Option<u64>,
    mergeable: Option<bool>,
    mergeable_state: Option<String>,
    html_url: String,
    #[serde(default)]
    labels: Vec<LabelRow>,
    #[serde(default)]
    requested_reviewers: Vec<ActorRow>,
}

/// `open`, `merged` or `closed`. GitHub reports a merged pull request as
/// closed, which hides the one outcome people look for.
fn state_of(row: &PullRow) -> String {
    if row.merged.unwrap_or(false) || row.merged_at.is_some() {
        "merged".to_string()
    } else {
        row.state.clone()
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Pull {
    pub number: u64,
    pub title: String,
    pub body: String,
    pub state: String,
    pub draft: bool,
    pub author: Option<String>,
    pub avatar_url: Option<String>,
    pub head: Option<String>,
    pub base: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub comments: u64,
    pub additions: Option<u64>,
    pub deletions: Option<u64>,
    pub changed_files: Option<u64>,
    /// Whether GitHub thinks it can merge cleanly; unknown until it has looked.
    pub mergeable: Option<bool>,
    /// `clean`, `blocked`, `dirty`, `behind` and the rest of GitHub's words.
    pub merge_state: Option<String>,
    pub labels: Vec<Label>,
    pub reviewers: Vec<String>,
    pub url: String,
}

impl From<PullRow> for Pull {
    fn from(row: PullRow) -> Self {
        Self {
            state: state_of(&row),
            number: row.number,
            title: row.title,
            body: row.body.unwrap_or_default(),
            draft: row.draft.unwrap_or(false),
            author: login_of(&row.user),
            avatar_url: avatar_of(&row.user),
            head: row.head.map(|side| side.name),
            base: row.base.map(|side| side.name),
            created_at: row.created_at,
            updated_at: row.updated_at,
            comments: row.comments.unwrap_or(0),
            additions: row.additions,
            deletions: row.deletions,
            changed_files: row.changed_files,
            mergeable: row.mergeable,
            merge_state: row.mergeable_state,
            labels: row.labels.into_iter().map(Label::from).collect(),
            reviewers: row
                .requested_reviewers
                .into_iter()
                .map(|actor| actor.login)
                .collect(),
            url: row.html_url,
        }
    }
}

const STATES: [&str; 3] = ["open", "closed", "all"];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Query {
    #[serde(flatten)]
    pub repo: RepoRef,
    pub state: Option<String>,
    pub page: Option<u32>,
    pub per_page: Option<u32>,
}

pub async fn list(data_dir: &Path, input: Query) -> ActionsResult<Vec<Pull>> {
    let state = input.state.unwrap_or_else(|| "open".into());
    if !STATES.contains(&state.as_str()) {
        return Err(ActionsError::BadArg(format!(
            "`{state}` is not open, closed or all"
        )));
    }
    let rows: Vec<PullRow> = client::get(
        data_dir,
        &input.repo.path("/pulls")?,
        &[
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
        ],
    )
    .await?;
    Ok(rows.into_iter().map(Pull::from).collect())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRef {
    #[serde(flatten)]
    pub repo: RepoRef,
    pub number: u64,
}

pub async fn get(data_dir: &Path, input: PullRef) -> ActionsResult<Pull> {
    let path = input.repo.path(&format!("/pulls/{}", input.number))?;
    let row: PullRow = client::get(data_dir, &path, &[]).await?;
    Ok(Pull::from(row))
}

#[derive(Deserialize)]
struct FileRow {
    filename: String,
    status: String,
    additions: u64,
    deletions: u64,
    patch: Option<String>,
    previous_filename: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    /// `added`, `modified`, `removed`, `renamed`, `copied` or `changed`.
    pub status: String,
    pub additions: u64,
    pub deletions: u64,
    pub previous_path: Option<String>,
    /// The unified diff, which GitHub leaves out for a file too big to show.
    pub patch: Option<String>,
}

pub async fn files(data_dir: &Path, input: PullRef) -> ActionsResult<Vec<ChangedFile>> {
    let path = input.repo.path(&format!("/pulls/{}/files", input.number))?;
    let rows: Vec<FileRow> =
        client::get(data_dir, &path, &[("per_page", MAX_PER_PAGE.to_string())]).await?;
    Ok(rows
        .into_iter()
        .map(|row| ChangedFile {
            path: row.filename,
            status: row.status,
            additions: row.additions,
            deletions: row.deletions,
            previous_path: row.previous_filename,
            patch: row.patch,
        })
        .collect())
}

#[derive(Deserialize)]
struct ReviewRow {
    user: Option<ActorRow>,
    state: Option<String>,
    body: Option<String>,
    submitted_at: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Review {
    pub author: Option<String>,
    /// `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED` or `DISMISSED`.
    pub state: String,
    pub body: String,
    pub submitted_at: Option<String>,
}

pub async fn reviews(data_dir: &Path, input: PullRef) -> ActionsResult<Vec<Review>> {
    let path = input
        .repo
        .path(&format!("/pulls/{}/reviews", input.number))?;
    let rows: Vec<ReviewRow> =
        client::get(data_dir, &path, &[("per_page", MAX_PER_PAGE.to_string())]).await?;
    Ok(rows
        .into_iter()
        .filter(|row| row.state.as_deref() != Some("PENDING"))
        .map(|row| Review {
            author: login_of(&row.user),
            state: row.state.unwrap_or_else(|| "COMMENTED".into()),
            body: row.body.unwrap_or_default(),
            submitted_at: row.submitted_at,
        })
        .collect())
}

const MERGE_METHODS: [&str; 3] = ["merge", "squash", "rebase"];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Merge {
    #[serde(flatten)]
    pub pull: PullRef,
    /// `merge`, `squash` or `rebase`.
    pub method: String,
}

pub async fn merge(data_dir: &Path, input: Merge) -> ActionsResult<()> {
    if !MERGE_METHODS.contains(&input.method.as_str()) {
        return Err(ActionsError::BadArg(format!(
            "`{}` is not merge, squash or rebase",
            input.method
        )));
    }
    let path = input
        .pull
        .repo
        .path(&format!("/pulls/{}/merge", input.pull.number))?;
    let body = json!({ "merge_method": input.method });
    client::act(data_dir, reqwest::Method::PUT, &path, Some(&body)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn row(value: serde_json::Value) -> PullRow {
        serde_json::from_value(value).expect("parses")
    }

    fn base() -> serde_json::Value {
        json!({
            "number": 12, "title": "Add a thing", "state": "closed",
            "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-02T00:00:00Z",
            "html_url": "https://github.com/a/b/pull/12",
        })
    }

    #[test]
    fn a_merged_pull_request_says_merged_rather_than_closed() {
        let mut merged = base();
        merged["merged"] = json!(true);
        assert_eq!(state_of(&row(merged)), "merged");

        let mut by_date = base();
        by_date["merged_at"] = json!("2026-01-02T00:00:00Z");
        assert_eq!(state_of(&row(by_date)), "merged");
    }

    #[test]
    fn one_that_was_only_closed_still_says_closed() {
        assert_eq!(state_of(&row(base())), "closed");
        let mut open = base();
        open["state"] = json!("open");
        assert_eq!(state_of(&row(open)), "open");
    }

    #[test]
    fn reads_the_branches_and_the_counts() {
        let mut full = base();
        full["head"] = json!({ "ref": "feat/thing" });
        full["base"] = json!({ "ref": "main" });
        full["additions"] = json!(40);
        full["deletions"] = json!(2);
        full["labels"] = json!([{ "name": "bug", "color": "d73a4a" }]);
        full["requested_reviewers"] = json!([{ "login": "nodelike" }]);
        let pull = Pull::from(row(full));
        assert_eq!(pull.head.as_deref(), Some("feat/thing"));
        assert_eq!(pull.base.as_deref(), Some("main"));
        assert_eq!(pull.additions, Some(40));
        assert_eq!(pull.labels.first().map(|l| l.name.as_str()), Some("bug"));
        assert_eq!(pull.reviewers, ["nodelike"]);
        assert!(!pull.draft);
    }

    #[tokio::test]
    async fn refuses_a_state_and_a_merge_method_github_would_not_take() {
        let repo = || RepoRef {
            owner: "a".into(),
            name: "b".into(),
        };
        let dir = std::env::temp_dir();
        let bad_state = Query {
            repo: repo(),
            state: Some("sideways".into()),
            page: None,
            per_page: None,
        };
        assert!(list(&dir, bad_state).await.is_err());

        let bad_method = Merge {
            pull: PullRef {
                repo: repo(),
                number: 1,
            },
            method: "smash".into(),
        };
        assert!(merge(&dir, bad_method).await.is_err());
    }
}

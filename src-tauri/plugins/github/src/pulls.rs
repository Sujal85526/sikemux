// Pull requests: the list, one of them in full, the files it touches, and
// merging it. A pull request is also an issue in GitHub's API, so its comments
// come from there.

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::client;
use crate::common::{
    avatar_of, login_of, ActorRow, Label, LabelRow, FILE_PAGES, LIST_PAGES, MAX_PER_PAGE,
};
use crate::error::{GithubError, GithubResult};
use crate::workflows::RepoRef;

const DEFAULT_PER_PAGE: u32 = 30;

#[derive(Deserialize)]
struct BranchSide {
    #[serde(rename = "ref")]
    name: String,
    /// `owner:branch`, which names the fork a branch lives on.
    label: Option<String>,
    sha: Option<String>,
}

#[derive(Deserialize)]
struct MilestoneRow {
    title: String,
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
    merged_by: Option<ActorRow>,
    merge_commit_sha: Option<String>,
    commits: Option<u64>,
    user: Option<ActorRow>,
    author_association: Option<String>,
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
    #[serde(default)]
    assignees: Vec<ActorRow>,
    milestone: Option<MilestoneRow>,
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
    /// `OWNER`, `MEMBER`, `COLLABORATOR`, `CONTRIBUTOR` and the rest.
    pub author_association: Option<String>,
    pub head: Option<String>,
    pub head_label: Option<String>,
    pub base: Option<String>,
    /// The commit at the tip of the branch, which is what its checks ran on.
    pub head_sha: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    /// Absent when GitHub did not say, which its list of pull requests never does.
    pub comments: Option<u64>,
    pub additions: Option<u64>,
    pub deletions: Option<u64>,
    pub changed_files: Option<u64>,
    /// Whether GitHub thinks it can merge cleanly; unknown until it has looked.
    pub mergeable: Option<bool>,
    /// `clean`, `blocked`, `dirty`, `behind` and the rest of GitHub's words.
    pub merge_state: Option<String>,
    pub labels: Vec<Label>,
    pub reviewers: Vec<String>,
    pub assignees: Vec<String>,
    pub milestone: Option<String>,
    /// Absent from GitHub's list of pull requests, like the counts above.
    pub commits: Option<u64>,
    pub merged_at: Option<String>,
    pub merged_by: Option<String>,
    pub merge_commit_sha: Option<String>,
    /// The picture of each person named above by login alone.
    pub avatars: BTreeMap<String, String>,
    pub url: String,
}

impl From<PullRow> for Pull {
    fn from(row: PullRow) -> Self {
        let avatars = row
            .requested_reviewers
            .iter()
            .chain(&row.assignees)
            .chain(&row.merged_by)
            .filter_map(|actor| Some((actor.login.clone(), actor.avatar_url.clone()?)))
            .collect();
        Self {
            avatars,
            state: state_of(&row),
            number: row.number,
            title: row.title,
            body: row.body.unwrap_or_default(),
            draft: row.draft.unwrap_or(false),
            author: login_of(&row.user),
            avatar_url: avatar_of(&row.user),
            author_association: row.author_association,
            head_sha: row.head.as_ref().and_then(|side| side.sha.clone()),
            head_label: row.head.as_ref().and_then(|side| side.label.clone()),
            head: row.head.map(|side| side.name),
            base: row.base.map(|side| side.name),
            created_at: row.created_at,
            updated_at: row.updated_at,
            comments: row.comments,
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
            assignees: row.assignees.into_iter().map(|actor| actor.login).collect(),
            milestone: row.milestone.map(|milestone| milestone.title),
            commits: row.commits,
            merged_at: row.merged_at,
            merged_by: login_of(&row.merged_by),
            merge_commit_sha: row.merge_commit_sha,
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

pub async fn list(data_dir: &Path, input: Query) -> GithubResult<Vec<Pull>> {
    let state = input.state.unwrap_or_else(|| "open".into());
    if !STATES.contains(&state.as_str()) {
        return Err(GithubError::BadArg(format!(
            "`{state}` is not open, closed or all"
        )));
    }
    let per_page = input
        .per_page
        .unwrap_or(DEFAULT_PER_PAGE)
        .clamp(1, MAX_PER_PAGE);
    let page = input.page.unwrap_or(1).max(1);
    let rows: Vec<PullRow> = client::get(
        data_dir,
        &input.repo.path("/pulls")?,
        &[
            ("state", state.clone()),
            ("sort", "updated".to_string()),
            ("direction", "desc".to_string()),
            ("per_page", per_page.to_string()),
            ("page", page.to_string()),
        ],
    )
    .await?;
    let counts = comment_counts(data_dir, &input.repo, &state, per_page, page)
        .await
        .unwrap_or_default();
    Ok(rows
        .into_iter()
        .map(Pull::from)
        .map(|mut pull| {
            pull.comments = pull.comments.or_else(|| counts.get(&pull.number).copied());
            pull
        })
        .collect())
}

#[derive(Deserialize)]
struct CountRow {
    number: u64,
    comments: u64,
}

#[derive(Deserialize)]
struct CountPage {
    items: Vec<CountRow>,
}

/// The list of pull requests leaves out how many comments each has, and a
/// search for the same page, newest first, carries them.
async fn comment_counts(
    data_dir: &Path,
    repo: &RepoRef,
    state: &str,
    per_page: u32,
    page: u32,
) -> GithubResult<std::collections::HashMap<u64, u64>> {
    repo.checked()?;
    let mut terms = format!("repo:{}/{} is:pr", repo.owner, repo.name);
    if state != "all" {
        terms.push_str(&format!(" is:{state}"));
    }
    let found: CountPage = client::get(
        data_dir,
        "/search/issues",
        &[
            ("q", terms),
            ("sort", "updated".to_string()),
            ("order", "desc".to_string()),
            ("per_page", per_page.to_string()),
            ("page", page.to_string()),
        ],
    )
    .await?;
    Ok(found
        .items
        .into_iter()
        .map(|row| (row.number, row.comments))
        .collect())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRef {
    #[serde(flatten)]
    pub repo: RepoRef,
    pub number: u64,
}

pub async fn get(data_dir: &Path, input: PullRef) -> GithubResult<Pull> {
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

pub async fn files(data_dir: &Path, input: PullRef) -> GithubResult<Vec<ChangedFile>> {
    let path = input.repo.path(&format!("/pulls/{}/files", input.number))?;
    let rows: Vec<FileRow> = client::get_all(data_dir, &path, &[], FILE_PAGES, |rows| rows).await?;
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
struct GitAuthor {
    name: Option<String>,
    email: Option<String>,
    date: Option<String>,
}

#[derive(Deserialize)]
struct GitCommit {
    message: String,
    author: Option<GitAuthor>,
}

#[derive(Deserialize)]
struct CommitRow {
    sha: String,
    commit: GitCommit,
    author: Option<ActorRow>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PullCommit {
    pub sha: String,
    pub message: String,
    /// The GitHub login, or the name in the commit when no account matches it.
    pub author: Option<String>,
    pub avatar_url: Option<String>,
    pub date: Option<String>,
}

/// GitHub lists at most 250 of a pull request's commits.
const COMMIT_PAGES: u32 = 3;

pub async fn commits(data_dir: &Path, input: PullRef) -> GithubResult<Vec<PullCommit>> {
    let path = input
        .repo
        .path(&format!("/pulls/{}/commits", input.number))?;
    let rows: Vec<CommitRow> =
        client::get_all(data_dir, &path, &[], COMMIT_PAGES, |rows| rows).await?;
    Ok(rows
        .into_iter()
        .map(|row| {
            let git = row.commit.author;
            PullCommit {
                sha: row.sha,
                message: row.commit.message,
                avatar_url: avatar_of(&row.author),
                author: login_of(&row.author)
                    .or_else(|| git.as_ref().and_then(|author| author.name.clone())),
                date: git.and_then(|author| author.date),
            }
        })
        .collect())
}

/// Who wrote a commit, by the email in it, and the account GitHub matched that email to.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CommitAuthor {
    pub email: String,
    pub login: String,
    pub avatar_url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitsRef {
    #[serde(flatten)]
    pub repo: RepoRef,
    /// A branch, tag or commit to list from; the default branch when absent.
    pub git_ref: Option<String>,
}

/// The accounts behind the latest hundred commits' emails, so a git history
/// read locally, which has only names and emails, can show who they are.
pub async fn commit_authors(data_dir: &Path, input: CommitsRef) -> GithubResult<Vec<CommitAuthor>> {
    let path = input.repo.path("/commits")?;
    let query: Vec<(&str, String)> = input
        .git_ref
        .into_iter()
        .map(|git_ref| ("sha", git_ref))
        .collect();
    let rows: Vec<CommitRow> = client::get_all(data_dir, &path, &query, 1, |rows| rows).await?;
    let mut authors: Vec<CommitAuthor> = Vec::new();
    for row in rows {
        let (Some(email), Some(actor)) = (
            row.commit.author.and_then(|author| author.email),
            row.author,
        ) else {
            continue;
        };
        let Some(avatar_url) = actor.avatar_url else {
            continue;
        };
        if authors.iter().all(|known| known.email != email) {
            authors.push(CommitAuthor {
                email,
                login: actor.login,
                avatar_url,
            });
        }
    }
    Ok(authors)
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
    pub avatar_url: Option<String>,
    /// `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED` or `DISMISSED`.
    pub state: String,
    pub body: String,
    pub submitted_at: Option<String>,
}

pub async fn reviews(data_dir: &Path, input: PullRef) -> GithubResult<Vec<Review>> {
    let path = input
        .repo
        .path(&format!("/pulls/{}/reviews", input.number))?;
    let rows: Vec<ReviewRow> =
        client::get_all(data_dir, &path, &[], LIST_PAGES, |rows| rows).await?;
    Ok(rows
        .into_iter()
        .filter(|row| row.state.as_deref() != Some("PENDING"))
        .map(|row| Review {
            author: login_of(&row.user),
            avatar_url: avatar_of(&row.user),
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
    /// The head commit the person was looking at. GitHub refuses the merge if
    /// the branch has moved since, so nothing unseen lands.
    pub sha: String,
}

fn is_commit(sha: &str) -> bool {
    (40..=64).contains(&sha.len()) && sha.chars().all(|c| c.is_ascii_hexdigit())
}

pub async fn merge(data_dir: &Path, input: Merge) -> GithubResult<()> {
    if !MERGE_METHODS.contains(&input.method.as_str()) {
        return Err(GithubError::BadArg(format!(
            "`{}` is not merge, squash or rebase",
            input.method
        )));
    }
    if !is_commit(&input.sha) {
        return Err(GithubError::BadArg(
            "a merge needs the full head commit it was checked against".into(),
        ));
    }
    let path = input
        .pull
        .repo
        .path(&format!("/pulls/{}/merge", input.pull.number))?;
    let body = json!({ "merge_method": input.method, "sha": input.sha });
    match client::act(data_dir, reqwest::Method::PUT, &path, Some(&body)).await {
        Err(GithubError::Http { status: 409, .. }) => Err(GithubError::Http {
            status: 409,
            message: "the branch moved since you looked; reload the pull request and try again"
                .into(),
        }),
        outcome => outcome,
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewPull {
    #[serde(flatten)]
    pub repo: RepoRef,
    pub title: String,
    /// The branch the changes are on.
    pub head: String,
    /// The branch they are meant to land in.
    pub base: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub draft: bool,
}

pub async fn create(data_dir: &Path, input: NewPull) -> GithubResult<Pull> {
    let title = input.title.trim();
    if title.is_empty() {
        return Err(GithubError::BadArg("a pull request needs a title".into()));
    }
    if input.head.trim().is_empty() || input.base.trim().is_empty() {
        return Err(GithubError::BadArg(
            "a pull request needs both of its branches".into(),
        ));
    }
    let body = json!({
        "title": title,
        "head": input.head.trim(),
        "base": input.base.trim(),
        "body": input.body,
        "draft": input.draft,
    });
    let row: PullRow = client::send_json(
        data_dir,
        reqwest::Method::POST,
        &input.repo.path("/pulls")?,
        &body,
    )
    .await?;
    Ok(Pull::from(row))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetState {
    #[serde(flatten)]
    pub pull: PullRef,
    /// `open` or `closed`.
    pub state: String,
}

pub async fn set_state(data_dir: &Path, input: SetState) -> GithubResult<()> {
    if !matches!(input.state.as_str(), "open" | "closed") {
        return Err(GithubError::BadArg(format!(
            "`{}` is not open or closed",
            input.state
        )));
    }
    let path = input
        .pull
        .repo
        .path(&format!("/pulls/{}", input.pull.number))?;
    let body = json!({ "state": input.state });
    client::act(data_dir, reqwest::Method::PATCH, &path, Some(&body)).await
}

const REVIEW_EVENTS: [&str; 3] = ["APPROVE", "REQUEST_CHANGES", "COMMENT"];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewReview {
    #[serde(flatten)]
    pub pull: PullRef,
    /// `APPROVE`, `REQUEST_CHANGES` or `COMMENT`.
    pub event: String,
    #[serde(default)]
    pub body: String,
}

pub async fn review(data_dir: &Path, input: NewReview) -> GithubResult<()> {
    if !REVIEW_EVENTS.contains(&input.event.as_str()) {
        return Err(GithubError::BadArg(format!(
            "`{}` is not approve, request changes or comment",
            input.event
        )));
    }
    if input.event != "APPROVE" && input.body.trim().is_empty() {
        return Err(GithubError::BadArg(
            "say what needs changing, or what the comment is".into(),
        ));
    }
    let path = input
        .pull
        .repo
        .path(&format!("/pulls/{}/reviews", input.pull.number))?;
    let body = json!({ "event": input.event, "body": input.body });
    client::act(data_dir, reqwest::Method::POST, &path, Some(&body)).await
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
    fn only_a_full_commit_can_pin_a_merge() {
        assert!(is_commit("0123456789abcdef0123456789abcdef01234567"));
        assert!(is_commit(&"a".repeat(64)));
        assert!(!is_commit("abc123"));
        assert!(!is_commit(&"g".repeat(40)));
    }

    #[test]
    fn reads_the_branches_and_the_counts() {
        let mut full = base();
        full["head"] = json!({ "ref": "feat/thing", "sha": "abc123" });
        full["base"] = json!({ "ref": "main" });
        full["additions"] = json!(40);
        full["deletions"] = json!(2);
        full["labels"] = json!([{ "name": "bug", "color": "d73a4a" }]);
        full["requested_reviewers"] = json!([{ "login": "nodelike" }]);
        let pull = Pull::from(row(full));
        assert_eq!(pull.head.as_deref(), Some("feat/thing"));
        assert_eq!(pull.head_sha.as_deref(), Some("abc123"));
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
            sha: "a".repeat(40),
        };
        assert!(merge(&dir, bad_method).await.is_err());

        let unseen_head = Merge {
            pull: PullRef {
                repo: repo(),
                number: 1,
            },
            method: "squash".into(),
            sha: String::new(),
        };
        assert!(matches!(
            merge(&dir, unseen_head).await,
            Err(GithubError::BadArg(_))
        ));

        let bad_review = NewReview {
            pull: PullRef {
                repo: repo(),
                number: 1,
            },
            event: "LGTM".into(),
            body: String::new(),
        };
        assert!(review(&dir, bad_review).await.is_err());

        let silent_request = NewReview {
            pull: PullRef {
                repo: repo(),
                number: 1,
            },
            event: "REQUEST_CHANGES".into(),
            body: "  ".into(),
        };
        assert!(review(&dir, silent_request).await.is_err());

        let untitled = NewPull {
            repo: repo(),
            title: " ".into(),
            head: "feat".into(),
            base: "main".into(),
            body: String::new(),
            draft: false,
        };
        assert!(create(&dir, untitled).await.is_err());
    }
}

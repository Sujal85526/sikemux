// The handful of shapes every part of GitHub's API repeats: who did it, what
// it was tagged with, and what someone wrote underneath.

use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::client;
use crate::error::ActionsResult;
use crate::workflows::RepoRef;

pub const MAX_PER_PAGE: u32 = 100;
/// How many pages of a hundred a list is read to before it stops.
pub const LIST_PAGES: u32 = 10;
/// GitHub lists at most 3,000 of a pull request's files, so every one it will give.
pub const FILE_PAGES: u32 = 30;
/// Releases carry their notes, so only the newest hundred are read, in one request.
pub const RELEASE_PAGES: u32 = 1;

#[derive(Deserialize)]
pub struct ActorRow {
    pub login: String,
    pub avatar_url: Option<String>,
}

#[derive(Deserialize)]
pub struct LabelRow {
    pub name: String,
    pub color: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Label {
    pub name: String,
    /// The six hex digits GitHub stores, with no leading hash.
    pub color: String,
}

impl From<LabelRow> for Label {
    fn from(row: LabelRow) -> Self {
        Self {
            name: row.name,
            color: row.color.unwrap_or_else(|| "8b8898".into()),
        }
    }
}

pub fn login_of(actor: &Option<ActorRow>) -> Option<String> {
    actor.as_ref().map(|actor| actor.login.clone())
}

pub fn avatar_of(actor: &Option<ActorRow>) -> Option<String> {
    actor.as_ref().and_then(|actor| actor.avatar_url.clone())
}

#[derive(Deserialize)]
struct CommentRow {
    id: u64,
    user: Option<ActorRow>,
    body: Option<String>,
    created_at: String,
    html_url: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    pub id: u64,
    pub author: Option<String>,
    pub avatar_url: Option<String>,
    pub body: String,
    pub created_at: String,
    pub url: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    #[serde(flatten)]
    pub repo: RepoRef,
    pub number: u64,
}

/// Pull requests and issues share one comment thread in GitHub's API, which is
/// why both reach it through the issues path.
pub async fn comments(data_dir: &Path, repo: &RepoRef, number: u64) -> ActionsResult<Vec<Comment>> {
    let path = repo.path(&format!("/issues/{number}/comments"))?;
    let rows: Vec<CommentRow> =
        client::get_all(data_dir, &path, &[], LIST_PAGES, |rows| rows).await?;
    Ok(rows
        .into_iter()
        .map(|row| Comment {
            id: row.id,
            author: login_of(&row.user),
            avatar_url: avatar_of(&row.user),
            body: row.body.unwrap_or_default(),
            created_at: row.created_at,
            url: row.html_url,
        })
        .collect())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewComment {
    #[serde(flatten)]
    pub repo: RepoRef,
    pub number: u64,
    pub body: String,
}

pub async fn add_comment(data_dir: &Path, input: NewComment) -> ActionsResult<()> {
    let body = input.body.trim();
    if body.is_empty() {
        return Err(crate::error::ActionsError::BadArg(
            "a comment cannot be empty".into(),
        ));
    }
    let path = input
        .repo
        .path(&format!("/issues/{}/comments", input.number))?;
    client::post_empty(data_dir, &path, Some(&json!({ "body": body }))).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_label_without_a_colour_still_has_one() {
        let plain = Label::from(LabelRow {
            name: "bug".into(),
            color: None,
        });
        assert_eq!(plain.color, "8b8898");
        let coloured = Label::from(LabelRow {
            name: "bug".into(),
            color: Some("d73a4a".into()),
        });
        assert_eq!(coloured.color, "d73a4a");
    }

    #[test]
    fn reads_who_did_something_and_copes_when_nobody_did() {
        let somebody = Some(ActorRow {
            login: "nodelike".into(),
            avatar_url: Some("https://avatar".into()),
        });
        assert_eq!(login_of(&somebody).as_deref(), Some("nodelike"));
        assert_eq!(avatar_of(&somebody).as_deref(), Some("https://avatar"));
        assert_eq!(login_of(&None), None);
        assert_eq!(avatar_of(&None), None);
    }

    #[tokio::test]
    async fn an_empty_comment_is_refused_before_it_is_sent() {
        let input = NewComment {
            repo: RepoRef {
                owner: "a".into(),
                name: "b".into(),
            },
            number: 1,
            body: "   ".into(),
        };
        assert!(add_comment(&std::env::temp_dir(), input).await.is_err());
    }
}

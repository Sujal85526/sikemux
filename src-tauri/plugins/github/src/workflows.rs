// The workflows a repository has, and starting one by hand.

use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::client;
use crate::error::{ActionsError, ActionsResult};
use crate::repo::{self, Repo};

const MAX_PER_PAGE: u32 = 100;

#[derive(Deserialize)]
struct WorkflowRow {
    id: u64,
    name: String,
    path: String,
    state: String,
    html_url: String,
}

#[derive(Deserialize)]
struct WorkflowList {
    workflows: Vec<WorkflowRow>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Workflow {
    pub id: u64,
    pub name: String,
    pub path: String,
    /// `active`, or one of the several ways GitHub says a workflow is switched off.
    pub state: String,
    pub active: bool,
    pub url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoRef {
    pub owner: String,
    pub name: String,
}

impl RepoRef {
    pub fn checked(&self) -> ActionsResult<&Self> {
        repo::validate(&self.owner, &self.name)?;
        Ok(self)
    }

    pub fn path(&self, rest: &str) -> ActionsResult<String> {
        let checked = self.checked()?;
        Ok(format!("/repos/{}/{}{rest}", checked.owner, checked.name))
    }
}

impl From<&Repo> for RepoRef {
    fn from(repo: &Repo) -> Self {
        Self {
            owner: repo.owner.clone(),
            name: repo.name.clone(),
        }
    }
}

pub async fn list(data_dir: &Path, repo: RepoRef) -> ActionsResult<Vec<Workflow>> {
    let list: WorkflowList = client::get(
        data_dir,
        &repo.path("/actions/workflows")?,
        &[("per_page", MAX_PER_PAGE.to_string())],
    )
    .await?;
    Ok(list
        .workflows
        .into_iter()
        .map(|row| Workflow {
            active: row.state == "active",
            id: row.id,
            name: row.name,
            path: row.path,
            state: row.state,
            url: row.html_url,
        })
        .collect())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Dispatch {
    #[serde(flatten)]
    pub repo: RepoRef,
    pub workflow_id: u64,
    /// The branch or tag to run on.
    pub git_ref: String,
    #[serde(default)]
    pub inputs: Map<String, Value>,
}

/// Every `workflow_dispatch` input reaches GitHub as a string, whatever the
/// person typed it as.
fn as_strings(inputs: Map<String, Value>) -> Map<String, Value> {
    inputs
        .into_iter()
        .map(|(name, value)| {
            let text = match value {
                Value::String(text) => text,
                Value::Null => String::new(),
                other => other.to_string(),
            };
            (name, Value::String(text))
        })
        .collect()
}

fn valid_ref(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 255
        && !value.starts_with('-')
        && !value.contains("..")
        && !value.chars().any(|c| {
            c.is_ascii_whitespace()
                || c.is_ascii_control()
                || matches!(c, '~' | '^' | ':' | '?' | '*' | '[' | '\\')
        })
}

pub async fn dispatch(data_dir: &Path, input: Dispatch) -> ActionsResult<()> {
    let git_ref = input.git_ref.trim();
    if !valid_ref(git_ref) {
        return Err(ActionsError::BadArg(format!(
            "`{git_ref}` is not a branch or tag name"
        )));
    }
    let path = input.repo.path(&format!(
        "/actions/workflows/{}/dispatches",
        input.workflow_id
    ))?;
    let body = json!({ "ref": git_ref, "inputs": as_strings(input.inputs) });
    client::post_empty(data_dir, &path, Some(&body)).await
}

#[derive(Deserialize)]
struct BranchRow {
    name: String,
}

pub async fn branches(data_dir: &Path, repo: RepoRef) -> ActionsResult<Vec<String>> {
    let rows: Vec<BranchRow> = client::get(
        data_dir,
        &repo.path("/branches")?,
        &[("per_page", MAX_PER_PAGE.to_string())],
    )
    .await?;
    Ok(rows.into_iter().map(|row| row.name).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo() -> RepoRef {
        RepoRef {
            owner: "nodelike".into(),
            name: "sikemux".into(),
        }
    }

    #[test]
    fn builds_a_path_under_the_repository() -> ActionsResult<()> {
        assert_eq!(
            repo().path("/actions/runs")?,
            "/repos/nodelike/sikemux/actions/runs"
        );
        Ok(())
    }

    #[test]
    fn a_repository_that_could_escape_the_path_is_refused() {
        let escaping = RepoRef {
            owner: "..".into(),
            name: "x".into(),
        };
        assert!(escaping.path("/actions/runs").is_err());
    }

    #[test]
    fn every_dispatch_input_goes_over_as_a_string() {
        let inputs: Map<String, Value> = serde_json::from_value(
            json!({ "level": "debug", "count": 3, "dry": true, "none": null }),
        )
        .unwrap_or_default();
        let sent = as_strings(inputs);
        assert_eq!(sent.get("level"), Some(&json!("debug")));
        assert_eq!(sent.get("count"), Some(&json!("3")));
        assert_eq!(sent.get("dry"), Some(&json!("true")));
        assert_eq!(sent.get("none"), Some(&json!("")));
    }

    #[test]
    fn refuses_refs_that_git_would_not_accept() {
        assert!(valid_ref("main"));
        assert!(valid_ref("release/0.4"));
        assert!(valid_ref("v1.2.3"));
        assert!(!valid_ref(""));
        assert!(!valid_ref("my branch"));
        assert!(!valid_ref("a..b"));
        assert!(!valid_ref("-x"));
        assert!(!valid_ref("feat^2"));
    }
}

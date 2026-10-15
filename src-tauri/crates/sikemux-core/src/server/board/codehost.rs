//! Pull requests and their checks on the project's code host, through the
//! GitHub and Bitbucket plugins and the person's own sign-in to them, and
//! what reviewers say on them.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::auto::Pull;
use crate::server::plugins;

const HOSTS: [(&str, &str); 2] = [("github", "GitHub"), ("bitbucket", "Bitbucket")];
/// Conclusions that let a change through.
const PASSING: [&str; 3] = ["success", "skipped", "neutral"];

/// A repository on a code host, and the account that reaches it.
pub(super) struct Repo {
    host: &'static str,
    owner: String,
    name: String,
    account: Option<String>,
}

impl Repo {
    fn params(&self, more: Value) -> Value {
        let mut params = json!({ "owner": self.owner, "name": self.name, "account": self.account });
        if let (Some(params), Value::Object(more)) = (params.as_object_mut(), more) {
            params.extend(more);
        }
        params
    }
}

impl Pull {
    fn repo(&self) -> Repo {
        Repo {
            host: HOSTS
                .iter()
                .map(|(host, _)| *host)
                .find(|host| *host == self.host)
                .unwrap_or("github"),
            owner: self.owner.clone(),
            name: self.name.clone(),
            account: self.account.clone(),
        }
    }
}

fn text(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

/// The code host the remote `url` is on, with an account signed in to it.
pub(super) async fn find(url: &str) -> Result<Repo, String> {
    for (host, label) in HOSTS {
        let Ok(found) = plugins::call(host, "resolveRemote", json!({ "url": url })).await else {
            continue;
        };
        let repo = &found["repo"];
        let (Some(owner), Some(name)) = (text(repo, "owner"), text(repo, "name")) else {
            continue;
        };
        if found["sameHost"] != Value::Bool(true) {
            continue;
        }
        let account = plugins::call(host, "accountFor", json!({ "owner": owner, "name": name }))
            .await
            .ok()
            .and_then(|account| account.as_str().map(str::to_owned));
        if account.is_none() {
            return Err(format!(
                "sign in to {label} in Sikemux with an account that can reach {owner}/{name}, so Auto can open the pull request"
            ));
        }
        return Ok(Repo {
            host,
            owner,
            name,
            account,
        });
    }
    Err(
        "Auto opens pull requests on GitHub and Bitbucket, and this project's origin is on neither"
            .into(),
    )
}

/// The pull requests the commit `sha` came in through, the merged one first,
/// when the code host the remote `url` is on can tell.
pub(crate) async fn pulls_of(url: &str, sha: &str) -> Result<Vec<Value>, String> {
    let repo = find(url).await?;
    let found = plugins::call(repo.host, "commitPulls", repo.params(json!({ "sha": sha }))).await?;
    Ok(found.as_array().cloned().unwrap_or_default())
}

fn pull_of(repo: &Repo, found: &Value) -> Result<Pull, String> {
    let number = found["number"]
        .as_u64()
        .ok_or("the code host answered without the pull request's number")?;
    Ok(Pull {
        host: repo.host.to_owned(),
        owner: repo.owner.clone(),
        name: repo.name.clone(),
        number,
        url: text(found, "url").unwrap_or_default(),
        account: repo.account.clone(),
    })
}

/// Opens a pull request for `head` onto `base`, or finds the one already open.
pub(super) async fn open(
    repo: &Repo,
    title: &str,
    head: &str,
    base: &str,
    body: &str,
) -> Result<Pull, String> {
    let params = repo.params(json!({ "title": title, "head": head, "base": base, "body": body }));
    let error = match plugins::call(repo.host, "createPull", params).await {
        Ok(found) => return pull_of(repo, &found),
        Err(error) => error,
    };
    let open = plugins::call(repo.host, "pulls", repo.params(json!({ "state": "open" })))
        .await
        .unwrap_or_default();
    open.as_array()
        .into_iter()
        .flatten()
        .find(|pull| text(pull, "head").as_deref() == Some(head))
        .map(|found| pull_of(repo, found))
        .unwrap_or(Err(error))
}

pub(super) enum Checks {
    /// Nothing has run on the commit yet.
    None,
    Running,
    Passed,
    /// What failed, a line each.
    Failed(String),
}

/// How the CI runs on `sha` went.
pub(super) async fn checks(pull: &Pull, branch: &str, sha: &str) -> Result<Checks, String> {
    let repo = pull.repo();
    let page = plugins::call(
        repo.host,
        "runs",
        repo.params(json!({ "headSha": sha, "branch": branch, "perPage": 50 })),
    )
    .await?;
    let runs: Vec<&Value> = page["runs"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|run| run["sha"].as_str() == Some(sha))
        .collect();
    if runs.is_empty() {
        return Ok(Checks::None);
    }
    if runs
        .iter()
        .any(|run| run["status"].as_str() != Some("completed"))
    {
        return Ok(Checks::Running);
    }
    let failed: Vec<String> = runs
        .iter()
        .filter(|run| {
            !run["conclusion"]
                .as_str()
                .is_some_and(|conclusion| PASSING.contains(&conclusion))
        })
        .map(|run| {
            format!(
                "{}: {} {}",
                text(run, "name").unwrap_or_else(|| "a check".to_owned()),
                text(run, "conclusion").unwrap_or_else(|| "failed".to_owned()),
                text(run, "url").unwrap_or_default()
            )
            .trim_end()
            .to_owned()
        })
        .collect();
    Ok(if failed.is_empty() {
        Checks::Passed
    } else {
        Checks::Failed(failed.join("\n"))
    })
}

/// Where a pull request stands.
pub(super) struct Looked {
    /// `open`, `merged` or `closed`.
    pub state: String,
    /// Moves whenever anything on the pull request does, such as a comment.
    pub mark: String,
}

pub(super) async fn look(pull: &Pull) -> Result<Looked, String> {
    let repo = pull.repo();
    let found = plugins::call(
        repo.host,
        "pull",
        repo.params(json!({ "number": pull.number })),
    )
    .await?;
    Ok(Looked {
        state: text(&found, "state").unwrap_or_else(|| "open".to_owned()),
        mark: format!("{} {}", found["updatedAt"], found["comments"]),
    })
}

/// A comment or review left on a pull request.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Feedback {
    pub id: String,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default, skip_serializing)]
    pub bot: bool,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub line: Option<u64>,
    #[serde(default)]
    pub state: Option<String>,
    #[serde(default, skip_serializing)]
    pub at: String,
}

/// The comments and reviews on the pull request that changed at or after `since`.
pub(super) async fn feedback(pull: &Pull, since: Option<&str>) -> Result<Vec<Feedback>, String> {
    let repo = pull.repo();
    let found = plugins::call(
        repo.host,
        "reviewFeedback",
        repo.params(json!({ "number": pull.number, "since": since })),
    )
    .await?;
    serde_json::from_value(found).map_err(|error| error.to_string())
}

/// Answers each comment in its own thread with `(comment id, text, what it
/// said)`, then asks `reviewers` to look again where the host can.
pub(super) async fn answer(
    pull: &Pull,
    replies: &[(String, String, String)],
    reviewers: &[String],
) -> Result<(), String> {
    let repo = pull.repo();
    let replies: Vec<Value> = replies
        .iter()
        .map(|(to, body, quote)| json!({ "to": to, "body": body, "quote": quote }))
        .collect();
    plugins::call(
        repo.host,
        "answerReview",
        repo.params(json!({ "number": pull.number, "replies": replies, "reviewers": reviewers })),
    )
    .await
    .map(drop)
}

/// Closes the pull request without merging it.
pub(super) async fn close(pull: &Pull) -> Result<(), String> {
    let repo = pull.repo();
    plugins::call(
        repo.host,
        "setPullState",
        repo.params(json!({ "number": pull.number, "state": "closed" })),
    )
    .await
    .map(drop)
}

/// Merges the pull request at `sha`, the commit whose checks passed.
pub(super) async fn merge(pull: &Pull, sha: &str) -> Result<(), String> {
    let repo = pull.repo();
    let methods: &[Option<&str>] = if repo.host == "github" {
        &[Some("squash"), Some("merge"), Some("rebase")]
    } else {
        &[None]
    };
    let mut last = String::new();
    for method in methods {
        let params = repo.params(json!({ "number": pull.number, "method": method, "sha": sha }));
        match plugins::call(repo.host, "mergePull", params).await {
            Ok(_) => return Ok(()),
            Err(error) if error.to_lowercase().contains("not allowed") => last = error,
            Err(error) => return Err(error),
        }
    }
    Err(last)
}

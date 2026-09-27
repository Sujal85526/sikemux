// GitHub Actions: the workflow runs of whichever repository Sikemux has open.
//
//   config    — which GitHub this is, and where the token comes from
//   client    — the HTTP client, size limits, and GitHub's error shapes
//   auth      — signing in, signing out, and who the token belongs to
//   repo      — a git remote turned into owner and repository
//   workflows — the workflows a repository has, and starting one by hand
//   runs      — runs, the jobs in one, and re-running or stopping them
//   logs      — a job's log
//   watch     — following a run while it is going

mod auth;
mod client;
mod config;
mod error;
mod logs;
mod repo;
mod runs;
mod watch;
mod workflows;

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sikemux_plugin_api::{
    params, reply, Manifest, Plugin, PluginContext, PluginError, PluginFuture, StreamSink,
};

use crate::error::ActionsResult;

pub fn plugin() -> Result<Arc<dyn Plugin>, PluginError> {
    Ok(Arc::new(GithubActions {
        manifest: Manifest::from_json(include_str!("../manifest.json"))?,
    }))
}

struct GithubActions {
    manifest: Manifest,
}

async fn answer<T: Serialize>(
    result: impl std::future::Future<Output = ActionsResult<T>>,
) -> Result<Value, PluginError> {
    reply(result.await?)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteQuery {
    url: String,
}

/// What a git remote points at, and whether it is the GitHub this is signed in
/// to. A repository on another host is still described, so the view can say so
/// rather than showing nothing.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Resolved {
    repo: Option<repo::Repo>,
    slug: Option<String>,
    same_host: bool,
}

fn resolve(data_dir: &std::path::Path, query: RemoteQuery) -> Resolved {
    let host = config::load(data_dir).host;
    let found = repo::from_remote(&query.url);
    Resolved {
        same_host: found.as_ref().is_some_and(|repo| repo.host == host),
        slug: found.as_ref().map(repo::Repo::slug),
        repo: found,
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MineQuery {
    #[serde(default = "default_limit")]
    limit: u32,
}

fn default_limit() -> u32 {
    50
}

/// Everything the sign-in screen needs, after the sign-in went through.
async fn signed_in(
    data_dir: &std::path::Path,
    outcome: ActionsResult<()>,
) -> Result<Value, PluginError> {
    outcome?;
    reply(auth::status(data_dir).await)
}

impl Plugin for GithubActions {
    fn manifest(&self) -> &Manifest {
        &self.manifest
    }

    fn call<'a>(
        &'a self,
        ctx: &'a PluginContext,
        method: &'a str,
        input: Value,
    ) -> PluginFuture<'a, Value> {
        Box::pin(async move {
            let data_dir = ctx.data_dir();
            match method {
                "status" => reply(auth::status(data_dir).await),
                "signIn" => {
                    signed_in(data_dir, auth::sign_in(data_dir, params(input)?).await).await
                }
                "signOut" => answer(auth::sign_out(data_dir)).await,

                "resolveRemote" => reply(resolve(data_dir, params(input)?)),
                "myRepos" => {
                    let query: MineQuery = params(input)?;
                    answer(repo::mine(data_dir, query.limit)).await
                }

                "workflows" => answer(workflows::list(data_dir, params(input)?)).await,
                "branches" => answer(workflows::branches(data_dir, params(input)?)).await,
                "dispatch" => answer(workflows::dispatch(data_dir, params(input)?)).await,

                "runs" => answer(runs::list(data_dir, params(input)?)).await,
                "run" => answer(runs::detail(data_dir, params(input)?)).await,
                "jobs" => answer(runs::jobs(data_dir, params(input)?)).await,
                "rerun" => answer(runs::rerun(data_dir, params(input)?)).await,
                "rerunJob" => answer(runs::rerun_job(data_dir, params(input)?)).await,
                "cancel" => answer(runs::cancel(data_dir, params(input)?)).await,

                "jobLog" => answer(logs::job(data_dir, params(input)?)).await,

                _ => Err(PluginError::unknown_method(method)),
            }
        })
    }

    fn stream<'a>(
        &'a self,
        ctx: &'a PluginContext,
        method: &'a str,
        input: Value,
        sink: StreamSink,
    ) -> PluginFuture<'a, ()> {
        Box::pin(async move {
            match method {
                "watchRun" => watch::run(ctx.data_dir(), params(input)?, sink).await,
                _ => Err(PluginError::unknown_method(method)),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn its_manifest_parses() {
        assert_eq!(
            plugin().expect("manifest parses").manifest().id,
            "sikemux.github-actions"
        );
    }

    #[tokio::test]
    async fn an_unknown_method_is_refused() {
        let plugin = plugin().expect("plugin loads");
        let ctx = PluginContext::new(std::env::temp_dir().join("sikemux-gha-unknown"));
        let error = plugin
            .call(&ctx, "nonsense", Value::Null)
            .await
            .expect_err("refused");
        assert_eq!(error.category, "unknown-method");
    }

    #[tokio::test]
    async fn reading_a_remote_never_needs_the_network() {
        let plugin = plugin().expect("plugin loads");
        let ctx = PluginContext::new(std::env::temp_dir().join("sikemux-gha-remote"));
        let resolved = plugin
            .call(
                &ctx,
                "resolveRemote",
                json!({ "url": "git@github.com:nodelike/sikemux.git" }),
            )
            .await
            .expect("resolves");
        assert_eq!(resolved["slug"], "nodelike/sikemux");
        assert_eq!(resolved["sameHost"], true);

        let elsewhere = plugin
            .call(
                &ctx,
                "resolveRemote",
                json!({ "url": "git@gitlab.com:team/thing.git" }),
            )
            .await
            .expect("resolves");
        assert_eq!(elsewhere["sameHost"], false);
        assert_eq!(elsewhere["slug"], "team/thing");

        let nothing = plugin
            .call(&ctx, "resolveRemote", json!({ "url": "/srv/local.git" }))
            .await
            .expect("resolves");
        assert_eq!(nothing["repo"], Value::Null);
    }
}

/// Runs against a real GitHub only when asked:
/// `GHA_LIVE_REPO=owner/repo GHA_LIVE_TOKEN=… cargo test -p sikemux-plugin-github-actions -- --ignored`
#[cfg(test)]
mod live {
    use super::*;
    use serde_json::json;

    fn env(name: &str) -> Option<String> {
        std::env::var(name).ok().filter(|value| !value.is_empty())
    }

    #[tokio::test]
    #[ignore]
    async fn reads_workflows_runs_and_a_log() {
        let (Some(slug), Some(token)) = (env("GHA_LIVE_REPO"), env("GHA_LIVE_TOKEN")) else {
            return;
        };
        let dir = std::env::temp_dir().join(format!("sikemux-gha-live-{}", std::process::id()));
        let ctx = PluginContext::new(dir.clone());
        let plugin = plugin().expect("plugin loads");
        let (owner, name) = slug.split_once('/').expect("GHA_LIVE_REPO is owner/repo");

        let status = plugin
            .call(
                &ctx,
                "signIn",
                json!({ "host": "github.com", "token": token }),
            )
            .await
            .expect("sign in");
        assert_eq!(status["ok"], true, "{status}");

        let target = json!({ "owner": owner, "name": name });
        let workflows = plugin
            .call(&ctx, "workflows", target.clone())
            .await
            .expect("workflows");
        assert!(workflows.as_array().is_some_and(|rows| !rows.is_empty()));

        let page = plugin
            .call(
                &ctx,
                "runs",
                json!({ "owner": owner, "name": name, "perPage": 5 }),
            )
            .await
            .expect("runs");
        let rows = page["runs"].as_array().expect("run rows");
        assert!(rows.len() <= 5);
        let Some(run_id) = rows.first().and_then(|row| row["id"].as_u64()) else {
            return;
        };

        let detail = plugin
            .call(
                &ctx,
                "run",
                json!({ "owner": owner, "name": name, "runId": run_id }),
            )
            .await
            .expect("run detail");
        assert_eq!(detail["run"]["id"], run_id);

        if let Some(job_id) = detail["jobs"]
            .as_array()
            .and_then(|jobs| jobs.first())
            .and_then(|job| job["id"].as_u64())
        {
            let log = plugin
                .call(
                    &ctx,
                    "jobLog",
                    json!({ "owner": owner, "name": name, "jobId": job_id }),
                )
                .await
                .expect("job log");
            assert!(log["expired"].is_boolean());
        }

        plugin
            .call(&ctx, "signOut", Value::Null)
            .await
            .expect("sign out");
        std::fs::remove_dir_all(dir).ok();
    }
}

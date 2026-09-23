// Rundeck integration — full-fledged in-app deploy center.
//
// Unlike the AWS surface (which shells out to the `aws` CLI), Rundeck talks
// plain bearer-token REST so we hit the API directly via reqwest. Reasons:
//
//   1. The matrix dashboard fans out N × M (services × envs) per refresh —
//      one async HTTP client with keep-alive beats forking subprocess-per-cell.
//   2. The live execution view streams /state + /output diffs every ~1.5s
//      to a Tauri Channel. Subprocess polling can't give us that shape.
//   3. The bash CLI's auth flow is the only really tricky bit; we mirror it
//      faithfully and stay byte-compatible with `~/.rd-config` so `rnd login`
//      from a terminal and our in-app login coexist.
//
// Module split:
//   config      — read/write ~/.rd-config (CLI-compatible key=value)
//   client      — shared reqwest::Client + auto-refresh on 401/403
//   auth        — j_security_check → POST /tokens/{user}; verify via /system/info
//   projects    — projects, jobs, branches_matrix (parallel)
//   executions  — last, history, run, abort
//   watch       — stream of execution state until it finishes
//   logs        — stream of log output with an offset cursor
//   plan        — read-only git inspection (dirty / ahead-behind / relation)

mod auth;
mod client;
mod config;
mod error;
mod executions;
mod logs;
mod plan;
mod projects;
mod watch;

use std::collections::HashMap;
use std::sync::Arc;

use serde::Deserialize;
use serde_json::Value;
use sikemux_plugin_api::{
    params, reply, Manifest, Plugin, PluginContext, PluginError, PluginFuture, StreamSink,
};

use crate::error::RundeckResult;

pub fn plugin() -> Result<Arc<dyn Plugin>, PluginError> {
    Ok(Arc::new(Rundeck {
        manifest: Manifest::from_json(include_str!("../manifest.json"))?,
    }))
}

struct Rundeck {
    manifest: Manifest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectParams {
    project: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServiceParams {
    project: String,
    service: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MatrixParams {
    envs: Vec<projects::EnvSpec>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExecutionsParams {
    job_id: String,
    project: String,
    max: Option<u32>,
    only_succeeded: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExecutionParams {
    execution_id: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunParams {
    project: String,
    service: String,
    branch: String,
    extra_options: Option<HashMap<String, String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanParams {
    project: String,
    service: String,
    target_branch: String,
    repo_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LogsParams {
    execution_id: u64,
    backlog: Option<u32>,
}

async fn answer<T: serde::Serialize>(
    result: impl std::future::Future<Output = RundeckResult<T>>,
) -> Result<Value, PluginError> {
    reply(result.await?)
}

impl Plugin for Rundeck {
    fn manifest(&self) -> &Manifest {
        &self.manifest
    }

    fn call<'a>(
        &'a self,
        _ctx: &'a PluginContext,
        method: &'a str,
        input: Value,
    ) -> PluginFuture<'a, Value> {
        Box::pin(async move {
            match method {
                "status" => reply(auth::status().await),
                "login" => answer(auth::login(params(input)?)).await,
                "logout" => answer(auth::logout()).await,
                "projects" => answer(projects::projects()).await,
                "jobs" => {
                    let ProjectParams { project } = params(input)?;
                    answer(projects::jobs(project)).await
                }
                "branchesMatrix" => {
                    let MatrixParams { envs } = params(input)?;
                    answer(projects::branches_matrix(envs)).await
                }
                "resolveJob" => {
                    let ServiceParams { project, service } = params(input)?;
                    answer(projects::resolve_job(&project, &service)).await
                }
                "executions" => {
                    let p: ExecutionsParams = params(input)?;
                    answer(executions::executions(
                        p.job_id,
                        p.project,
                        p.max,
                        p.only_succeeded,
                    ))
                    .await
                }
                "execution" => {
                    let ExecutionParams { execution_id } = params(input)?;
                    answer(executions::execution(execution_id)).await
                }
                "executionState" => {
                    let ExecutionParams { execution_id } = params(input)?;
                    answer(executions::execution_state(execution_id)).await
                }
                "run" => {
                    let p: RunParams = params(input)?;
                    answer(executions::run(
                        p.project,
                        p.service,
                        p.branch,
                        p.extra_options,
                    ))
                    .await
                }
                "abort" => {
                    let ExecutionParams { execution_id } = params(input)?;
                    answer(executions::abort(execution_id)).await
                }
                "plan" => {
                    let p: PlanParams = params(input)?;
                    answer(plan::plan(
                        p.project,
                        p.service,
                        p.target_branch,
                        p.repo_path,
                    ))
                    .await
                }
                _ => Err(PluginError::unknown_method(method)),
            }
        })
    }

    fn stream<'a>(
        &'a self,
        _ctx: &'a PluginContext,
        method: &'a str,
        input: Value,
        sink: StreamSink,
    ) -> PluginFuture<'a, ()> {
        Box::pin(async move {
            match method {
                "watch" => {
                    let ExecutionParams { execution_id } = params(input)?;
                    watch::watch(execution_id, sink).await
                }
                "logs" => {
                    let LogsParams {
                        execution_id,
                        backlog,
                    } = params(input)?;
                    logs::logs(execution_id, backlog, sink).await
                }
                _ => Err(PluginError::unknown_method(method)),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn its_manifest_parses() {
        let plugin = plugin().expect("manifest parses");
        assert_eq!(plugin.manifest().id, "sikemux.rundeck");
    }
}

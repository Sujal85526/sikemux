// Execution endpoints: history, single fetch, trigger (with BRANCH option),
// and abort. State/output polling lives in watch.rs / logs.rs.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::error::AppResult;

use super::client::{get_json, post_empty_json, post_json};
use super::projects::resolve_job;

#[derive(Serialize, Clone, Deserialize)]
pub struct Execution {
    pub id: u64,
    pub status: Option<String>,
    pub user: Option<String>,
    pub project: Option<String>,
    #[serde(rename = "date-started")]
    pub date_started: Option<DateField>,
    #[serde(rename = "date-ended")]
    pub date_ended: Option<DateField>,
    pub permalink: Option<String>,
    pub job: Option<JobRef>,
    #[serde(rename = "argstring")]
    pub argstring: Option<String>,
}

#[derive(Serialize, Clone, Deserialize)]
pub struct JobRef {
    pub id: Option<String>,
    pub name: Option<String>,
    pub group: Option<String>,
    pub project: Option<String>,
    pub options: Option<HashMap<String, String>>,
}

#[derive(Serialize, Clone, Deserialize)]
pub struct DateField {
    pub date: Option<String>,
    pub unixtime: Option<i64>,
}

#[derive(Deserialize)]
struct ExecutionList {
    executions: Vec<Execution>,
}

#[tauri::command]
pub async fn rnd_executions(
    job_id: String,
    max: Option<u32>,
    only_succeeded: Option<bool>,
) -> AppResult<Vec<Execution>> {
    let mut query: Vec<(&str, String)> =
        vec![("max", max.unwrap_or(25).to_string())];
    if only_succeeded.unwrap_or(false) {
        query.push(("status", "succeeded".into()));
    }
    let path = format!("/job/{job_id}/executions");
    let resp: ExecutionList = get_json(&path, &query).await?;
    Ok(resp.executions)
}

#[tauri::command]
pub async fn rnd_execution(execution_id: u64) -> AppResult<Execution> {
    get_json(&format!("/execution/{execution_id}"), &[]).await
}

#[derive(Serialize, Clone, Deserialize)]
pub struct RunResult {
    pub id: u64,
    pub permalink: Option<String>,
    pub status: Option<String>,
}

#[derive(Serialize)]
struct RunRequest<'a> {
    options: HashMap<&'a str, String>,
}

/// Trigger a job. `extra_options` is anything beyond BRANCH (pass None when
/// the form has nothing extra to send).
#[tauri::command]
pub async fn rnd_run(
    project: String,
    service: String,
    branch: String,
    extra_options: Option<HashMap<String, String>>,
) -> AppResult<RunResult> {
    let job = resolve_job(&project, &service).await?;
    let mut options: HashMap<&str, String> = HashMap::new();
    options.insert("BRANCH", branch);
    if let Some(extras) = extra_options {
        // Statically-known key lifetimes don't mix with String keys from the
        // wire, so collapse into a fresh json::Value rather than the typed
        // RunRequest helper.
        let mut payload = serde_json::Map::new();
        let mut opt_map = serde_json::Map::new();
        for (k, v) in extras {
            opt_map.insert(k, serde_json::Value::String(v));
        }
        for (k, v) in options {
            opt_map.insert(k.to_string(), serde_json::Value::String(v));
        }
        payload.insert("options".into(), serde_json::Value::Object(opt_map));
        let path = format!("/job/{}/run", job.id);
        return post_json(&path, &serde_json::Value::Object(payload)).await;
    }
    let payload = RunRequest { options };
    let path = format!("/job/{}/run", job.id);
    post_json(&path, &payload).await
}

#[derive(Serialize, Clone, Deserialize)]
pub struct AbortResult {
    pub abort: Option<AbortBody>,
    pub execution: Option<Execution>,
}

#[derive(Serialize, Clone, Deserialize)]
pub struct AbortBody {
    pub status: Option<String>,
    pub reason: Option<String>,
}

#[tauri::command]
pub async fn rnd_abort(execution_id: u64) -> AppResult<AbortResult> {
    post_empty_json(&format!("/execution/{execution_id}/abort")).await
}

// ---- Step / workflow state (used by watch.rs and also by single fetch UI) --
//
// Rundeck's actual /state JSON puts the step lifecycle fields FLAT on each
// step object — NOT in a nested `stepState` wrapper as the docs imply.
// Real shape: { id, stepctx, executionState, startTime, endTime, duration,
//               nodeStates, nodeStep, parameterStates }
// `stepString` (label) isn't in /state at all; it lives in the job
// definition. For now we surface stepctx as the visible label.

#[derive(Serialize, Clone, Deserialize, Default)]
pub struct Step {
    pub id: Option<String>,
    pub stepctx: Option<String>,
    #[serde(rename = "executionState")]
    pub execution_state: Option<String>,
    #[serde(rename = "startTime")]
    pub start_time: Option<String>,
    #[serde(rename = "endTime")]
    pub end_time: Option<String>,
    #[serde(rename = "nodeStep")]
    pub node_step: Option<bool>,
}

#[derive(Serialize, Clone, Deserialize, Default)]
pub struct WorkflowState {
    #[serde(rename = "executionState")]
    pub execution_state: Option<String>,
    #[serde(default)]
    pub steps: Vec<Step>,
    #[serde(rename = "stepCount")]
    pub step_count: Option<u32>,
    #[serde(rename = "completed")]
    pub completed: Option<bool>,
}

#[tauri::command]
pub async fn rnd_execution_state(execution_id: u64) -> AppResult<WorkflowState> {
    get_json(&format!("/execution/{execution_id}/state"), &[]).await
}

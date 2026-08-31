// Execution endpoints: history, single fetch, trigger (with BRANCH option),
// and abort. State/output polling lives in watch.rs / logs.rs.

use std::collections::{HashMap, HashSet};

use futures::future::join_all;
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
    #[serde(
        rename = "workflowState",
        default,
        skip_deserializing,
        skip_serializing_if = "Option::is_none"
    )]
    pub workflow_state: Option<WorkflowState>,
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
    project: String,
    max: Option<u32>,
    only_succeeded: Option<bool>,
) -> AppResult<Vec<Execution>> {
    let limit = max.unwrap_or(25);
    let succeeded_only = only_succeeded.unwrap_or(false);
    let mut query: Vec<(&str, String)> = vec![("max", limit.to_string())];
    if succeeded_only {
        query.push(("status", "succeeded".into()));
    }
    let path = format!("/job/{job_id}/executions");
    let history: ExecutionList = get_json(&path, &query).await?;

    let running = if succeeded_only {
        Vec::new()
    } else {
        let running_query = [("jobIdFilter", job_id.clone())];
        let running_path = format!("/project/{project}/executions/running");
        match get_json::<ExecutionList>(&running_path, &running_query).await {
            Ok(response) => response.executions,
            Err(_) => {
                let fallback_query = [
                    ("max", limit.to_string()),
                    ("status", "running".to_string()),
                ];
                get_json::<ExecutionList>(&path, &fallback_query)
                    .await
                    .map(|response| response.executions)
                    .unwrap_or_default()
            }
        }
    };

    let mut executions = merge_executions(history.executions, running, limit as usize);
    let states = join_all(executions.iter().map(|execution| async move {
        if !status_is_running(&execution.status) {
            return None;
        }
        get_json::<WorkflowState>(&format!("/execution/{}/state", execution.id), &[])
            .await
            .ok()
    }))
    .await;
    for (execution, state) in executions.iter_mut().zip(states) {
        execution.workflow_state = state;
    }
    Ok(executions)
}

fn status_is_running(status: &Option<String>) -> bool {
    status
        .as_deref()
        .is_some_and(|value| value.eq_ignore_ascii_case("running"))
}

fn merge_executions(
    history: Vec<Execution>,
    running: Vec<Execution>,
    limit: usize,
) -> Vec<Execution> {
    let running_ids: HashSet<_> = running.iter().map(|execution| execution.id).collect();
    let mut by_id = HashMap::with_capacity(history.len() + running.len());
    for execution in history.into_iter().chain(running) {
        by_id.insert(execution.id, execution);
    }
    let mut executions: Vec<_> = by_id.into_values().collect();
    executions.sort_by(|left, right| {
        execution_started_at(right)
            .cmp(&execution_started_at(left))
            .then_with(|| right.id.cmp(&left.id))
    });
    executions
        .into_iter()
        .enumerate()
        .filter_map(|(index, execution)| {
            (index < limit || running_ids.contains(&execution.id)).then_some(execution)
        })
        .collect()
}

fn execution_started_at(execution: &Execution) -> Option<i64> {
    execution
        .date_started
        .as_ref()
        .and_then(|started| started.unixtime)
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
    let branch = branch.trim().to_string();
    if branch.is_empty() {
        return Err(crate::error::AppError::BadArg("branch is empty"));
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn execution(id: u64, started_at: Option<i64>, status: &str) -> Execution {
        Execution {
            id,
            status: Some(status.into()),
            user: None,
            project: None,
            date_started: Some(DateField {
                date: None,
                unixtime: started_at,
            }),
            date_ended: None,
            permalink: None,
            job: None,
            argstring: None,
            workflow_state: None,
        }
    }

    #[test]
    fn merges_running_executions_and_sorts_latest_first() {
        let history = vec![execution(41, Some(1_000), "succeeded")];
        let running = vec![execution(42, Some(2_000), "running")];

        let result = merge_executions(history, running, 25);

        assert_eq!(
            result.iter().map(|item| item.id).collect::<Vec<_>>(),
            [42, 41]
        );
    }

    #[test]
    fn running_snapshot_replaces_duplicate_history_item() {
        let history = vec![execution(42, Some(2_000), "scheduled")];
        let running = vec![execution(42, Some(2_000), "running")];

        let result = merge_executions(history, running, 25);

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].status.as_deref(), Some("running"));
    }

    #[test]
    fn sorts_equal_or_missing_timestamps_by_execution_id() {
        let history = vec![
            execution(8, None, "succeeded"),
            execution(10, None, "failed"),
        ];

        let result = merge_executions(history, Vec::new(), 1);

        assert_eq!(result[0].id, 10);
    }

    #[test]
    fn retains_long_running_executions_beyond_the_history_limit() {
        let history = vec![
            execution(43, Some(3_000), "succeeded"),
            execution(42, Some(2_000), "succeeded"),
        ];
        let running = vec![execution(41, Some(1_000), "running")];

        let result = merge_executions(history, running, 2);

        assert_eq!(
            result.iter().map(|item| item.id).collect::<Vec<_>>(),
            [43, 42, 41]
        );
    }
}

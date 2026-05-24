// Project / job listing and the matrix dashboard's one-shot fan-out.
//
// The matrix endpoint resolves a list of environment "aliases" (dev /
// staging / preprod / prod) into real Rundeck project names, then in
// parallel fetches every job and its last successful execution. Result
// shape: { env → [{ service, branch, jobId, status, ranAt }] }. One Tauri
// round-trip drives the entire dashboard render.

use std::collections::HashMap;

use futures::future::join_all;
use serde::{Deserialize, Serialize};

use crate::error::AppResult;

use super::client::get_json;

// ---- projects ------------------------------------------------------------

#[derive(Serialize, Clone, Deserialize)]
pub struct RundeckProject {
    pub name: String,
    pub description: Option<String>,
}

#[tauri::command]
pub async fn rnd_projects() -> AppResult<Vec<RundeckProject>> {
    let mut out: Vec<RundeckProject> = get_json("/projects", &[]).await?;
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

// ---- jobs ---------------------------------------------------------------

#[derive(Serialize, Clone, Deserialize)]
pub struct RundeckJob {
    pub id: String,
    pub name: String,
    pub group: Option<String>,
    pub project: String,
    pub description: Option<String>,
    pub href: Option<String>,
    pub permalink: Option<String>,
}

impl RundeckJob {
    /// "group/name" or "name" when no group — same display the CLI uses.
    pub fn qualified_name(&self) -> String {
        match self.group.as_deref() {
            Some(g) if !g.is_empty() => format!("{g}/{}", self.name),
            _ => self.name.clone(),
        }
    }
}

#[tauri::command]
pub async fn rnd_jobs(project: String) -> AppResult<Vec<RundeckJob>> {
    let mut out: Vec<RundeckJob> =
        get_json(&format!("/project/{project}/jobs"), &[]).await?;
    out.sort_by(|a, b| a.qualified_name().cmp(&b.qualified_name()));
    Ok(out)
}

// ---- last-execution + branch matrix --------------------------------------

#[derive(Deserialize)]
struct ExecutionListResponse {
    executions: Vec<ExecutionLite>,
}

#[derive(Deserialize)]
struct ExecutionLite {
    id: u64,
    status: Option<String>,
    user: Option<String>,
    job: Option<ExecutionJobLite>,
    #[serde(rename = "date-started")]
    date_started: Option<DateField>,
    #[serde(rename = "date-ended")]
    date_ended: Option<DateField>,
    permalink: Option<String>,
}

#[derive(Deserialize)]
struct ExecutionJobLite {
    options: Option<HashMap<String, String>>,
}

#[derive(Deserialize)]
struct DateField {
    date: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct MatrixCell {
    pub service: String,
    pub job_id: String,
    pub group: Option<String>,
    pub branch: Option<String>,
    pub status: Option<String>,
    pub user: Option<String>,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
    pub execution_id: Option<u64>,
    pub permalink: Option<String>,
}

#[derive(Serialize)]
pub struct MatrixEnv {
    pub env: String,
    pub project: String,
    pub cells: Vec<MatrixCell>,
    pub error: Option<String>,
}

#[derive(Serialize)]
pub struct MatrixResult {
    pub envs: Vec<MatrixEnv>,
    pub elapsed_ms: u64,
}

#[derive(Deserialize)]
pub struct EnvSpec {
    pub label: String,
    pub project: String,
    #[serde(default)]
    pub only_succeeded: bool,
}

async fn fetch_last_for_job(job: &RundeckJob, only_succeeded: bool) -> MatrixCell {
    let mut query: Vec<(&str, String)> = vec![("max", "1".to_string())];
    if only_succeeded {
        query.push(("status", "succeeded".to_string()));
    }
    let path = format!("/job/{}/executions", job.id);
    let result: AppResult<ExecutionListResponse> = get_json(&path, &query).await;

    let mut cell = MatrixCell {
        service: job.qualified_name(),
        job_id: job.id.clone(),
        group: job.group.clone(),
        branch: None,
        status: None,
        user: None,
        started_at: None,
        ended_at: None,
        execution_id: None,
        permalink: None,
    };
    if let Ok(resp) = result {
        if let Some(ex) = resp.executions.into_iter().next() {
            cell.execution_id = Some(ex.id);
            cell.status = ex.status;
            cell.user = ex.user;
            cell.permalink = ex.permalink;
            cell.started_at = ex.date_started.and_then(|d| d.date);
            cell.ended_at = ex.date_ended.and_then(|d| d.date);
            cell.branch = ex
                .job
                .and_then(|j| j.options)
                .and_then(|opts| opts.get("BRANCH").cloned());
        }
    }
    cell
}

#[tauri::command]
pub async fn rnd_branches_matrix(envs: Vec<EnvSpec>) -> AppResult<MatrixResult> {
    let started = std::time::Instant::now();

    let per_env = join_all(envs.into_iter().map(|spec| async move {
        let jobs_result = rnd_jobs(spec.project.clone()).await;
        let (cells, err) = match jobs_result {
            Ok(jobs) => {
                let cells = join_all(
                    jobs.iter()
                        .map(|j| fetch_last_for_job(j, spec.only_succeeded)),
                )
                .await;
                (cells, None)
            }
            Err(e) => (Vec::new(), Some(e.to_string())),
        };
        MatrixEnv {
            env: spec.label,
            project: spec.project,
            cells,
            error: err,
        }
    }))
    .await;

    Ok(MatrixResult {
        envs: per_env,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

/// Convenience for the deploy flow — resolves group/name to a single job id,
/// erroring on ambiguity. Mirrors `_find_job_id` in the bash CLI.
pub async fn resolve_job(project: &str, service_ref: &str) -> AppResult<RundeckJob> {
    let jobs = rnd_jobs(project.to_string()).await?;
    let (target_group, target_name) = match service_ref.split_once('/') {
        Some((g, n)) => (Some(g.to_string()), n.to_string()),
        None => (None, service_ref.to_string()),
    };
    let matches: Vec<&RundeckJob> = jobs
        .iter()
        .filter(|j| j.name == target_name)
        .filter(|j| match &target_group {
            Some(g) => j.group.as_deref() == Some(g.as_str()),
            None => true,
        })
        .collect();
    match matches.as_slice() {
        [] => Err(crate::error::AppError::Rundeck(format!(
            "job '{service_ref}' not found in project '{project}'"
        ))),
        [j] => Ok((*j).clone()),
        many => Err(crate::error::AppError::Rundeck(format!(
            "job '{service_ref}' is ambiguous in '{project}' ({} matches — pass group/name)",
            many.len()
        ))),
    }
}

#[tauri::command]
pub async fn rnd_resolve_job(project: String, service: String) -> AppResult<RundeckJob> {
    resolve_job(&project, &service).await
}


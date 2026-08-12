// Read-only pre-deploy plan. Mirrors `cmd_plan` from the bash CLI:
// inspect git state, project's last successful deploy on this env, and the
// relation between the two so the user can sanity-check before pushing the
// big red button. Pure git2 — no shell-out.

use git2::{BranchType, Repository};
use serde::Serialize;
use std::time::Duration;

use crate::bounded_process;
use crate::error::AppResult;

use super::client::get_json;
use super::executions::Execution;
use super::projects::resolve_job;

#[derive(Serialize, Clone)]
pub struct PlanResult {
    pub project: String,
    pub service: String,
    pub target_branch: String,

    pub deployed_branch: Option<String>,
    pub branch_relation: BranchRelation,
    pub branch_relation_detail: Option<String>,

    pub git_root: Option<String>,
    pub current_branch: Option<String>,
    pub head_sha: Option<String>,
    pub dirty: bool,
    pub upstream: Option<String>,
    pub ahead: Option<u32>,
    pub behind: Option<u32>,
    pub remote_target_exists: bool,
    pub push_action: PushAction,
}

#[derive(Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum BranchRelation {
    Same,
    TargetContainsDeployed,
    TargetMissingDeployed,
    UnknownNoDeployedBranch,
    UnknownDeployedNotOnOrigin,
    UnknownTargetNotOnOrigin,
}

#[derive(Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PushAction {
    #[serde(rename = "will-push-current")]
    PushCurrent,
    #[serde(rename = "will-not-push-different-branch")]
    NotPushDifferentBranch,
    #[serde(rename = "will-not-push-no-repo")]
    NotPushNoRepo,
    #[serde(rename = "will-not-push-detached")]
    NotPushDetached,
}

#[derive(serde::Deserialize)]
struct ExecutionList {
    executions: Vec<Execution>,
}

/// Compute a read-only deploy plan. `target_branch` is the branch to deploy
/// (caller resolves "current" before calling — we don't peek the cwd). Pass
/// an empty `repo_path` if you don't have a local checkout — git-side fields
/// will fall back to "no repo" semantics.
#[tauri::command]
pub async fn rnd_plan(
    project: String,
    service: String,
    target_branch: String,
    repo_path: String,
) -> AppResult<PlanResult> {
    let target_branch = target_branch.trim().to_string();
    let job = resolve_job(&project, &service).await?;

    // Last-successful deploy via API; tolerant of error (caller still wants
    // the git-side analysis).
    let deployed_branch: Option<String> = {
        let res: AppResult<ExecutionList> = get_json(
            &format!("/job/{}/executions", job.id),
            &[
                ("max", "1".to_string()),
                ("status", "succeeded".to_string()),
            ],
        )
        .await;
        res.ok()
            .and_then(|l| l.executions.into_iter().next())
            .and_then(|e| e.job)
            .and_then(|j| j.options)
            .and_then(|o| o.get("BRANCH").cloned())
    };

    let mut plan = PlanResult {
        project: project.clone(),
        service: service.clone(),
        target_branch: target_branch.clone(),
        deployed_branch: deployed_branch.clone(),
        branch_relation: BranchRelation::UnknownNoDeployedBranch,
        branch_relation_detail: None,
        git_root: None,
        current_branch: None,
        head_sha: None,
        dirty: false,
        upstream: None,
        ahead: None,
        behind: None,
        remote_target_exists: false,
        push_action: PushAction::NotPushNoRepo,
    };

    if repo_path.trim().is_empty() {
        if let Some(d) = &deployed_branch {
            plan.branch_relation = if d == &target_branch {
                BranchRelation::Same
            } else {
                BranchRelation::UnknownDeployedNotOnOrigin
            };
        }
        return Ok(plan);
    }

    let repo = match Repository::discover(&repo_path) {
        Ok(r) => r,
        Err(_) => return Ok(plan),
    };
    plan.git_root = repo.workdir().map(|p| p.to_string_lossy().to_string());

    // Best-effort fetch — we want fresh refs but tolerate offline machines.
    let mut fetch = std::process::Command::new("git");
    fetch
        .arg("-C")
        .arg(&repo_path)
        .args(["fetch", "origin", "--quiet"])
        .env("GIT_TERMINAL_PROMPT", "0");
    let _ = bounded_process::run(
        &mut fetch,
        None,
        Duration::from_secs(30),
        4 * 1024 * 1024,
        None,
    );

    // HEAD info
    if let Ok(head) = repo.head() {
        if let Ok(name) = head.shorthand() {
            plan.current_branch = Some(name.to_string());
        }
        if let Some(oid) = head.target() {
            let s = oid.to_string();
            plan.head_sha = Some(s.chars().take(7).collect());
        }
    }

    // Dirty tree
    if let Ok(statuses) = repo.statuses(None) {
        plan.dirty = statuses
            .iter()
            .any(|s| !s.status().is_ignored() && !(s.status().is_empty()));
    }

    // Upstream + ahead/behind
    if let Some(branch_name) = &plan.current_branch {
        if let Ok(branch) = repo.find_branch(branch_name, BranchType::Local) {
            if let Ok(upstream) = branch.upstream() {
                if let Some(uname) = upstream.name().ok().flatten() {
                    plan.upstream = Some(uname.to_string());
                    if let (Some(local_oid), Some(up_oid)) = (
                        branch.into_reference().target(),
                        upstream.into_reference().target(),
                    ) {
                        if let Ok((ahead, behind)) = repo.graph_ahead_behind(local_oid, up_oid) {
                            plan.ahead = Some(ahead as u32);
                            plan.behind = Some(behind as u32);
                        }
                    }
                }
            }
        }
    }

    // Remote target ref exists?
    plan.remote_target_exists = repo
        .find_reference(&format!("refs/remotes/origin/{target_branch}"))
        .is_ok();

    // Push action prediction
    plan.push_action = match &plan.current_branch {
        Some(cb) if cb == &target_branch => PushAction::PushCurrent,
        Some(_) => PushAction::NotPushDifferentBranch,
        None => PushAction::NotPushDetached,
    };

    // Branch relation
    plan.branch_relation = match (&deployed_branch, plan.remote_target_exists) {
        (None, _) => BranchRelation::UnknownNoDeployedBranch,
        (Some(d), _) if d == &target_branch => BranchRelation::Same,
        (Some(d), true) => {
            let deployed_ref = repo.find_reference(&format!("refs/remotes/origin/{d}"));
            if deployed_ref.is_err() {
                BranchRelation::UnknownDeployedNotOnOrigin
            } else {
                // Resolve OIDs and check ancestry.
                let target_ref = repo
                    .find_reference(&format!("refs/remotes/origin/{target_branch}"))
                    .ok()
                    .and_then(|r| r.target());
                let deployed_oid = deployed_ref.ok().and_then(|r| r.target());
                match (target_ref, deployed_oid) {
                    (Some(t), Some(d_oid)) => {
                        let is_ancestor =
                            repo.graph_descendant_of(t, d_oid).unwrap_or(false) || t == d_oid;
                        if is_ancestor {
                            BranchRelation::TargetContainsDeployed
                        } else {
                            plan.branch_relation_detail = Some(format!(
                                "Deploying will switch {}/{} to a different line of work.",
                                project, service
                            ));
                            BranchRelation::TargetMissingDeployed
                        }
                    }
                    _ => BranchRelation::UnknownTargetNotOnOrigin,
                }
            }
        }
        (Some(_), false) => BranchRelation::UnknownTargetNotOnOrigin,
    };

    Ok(plan)
}

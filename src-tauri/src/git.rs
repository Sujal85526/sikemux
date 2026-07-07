use std::io::{ErrorKind, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::Mutex;

use git2::{
    BranchType, DiffFormat, DiffLineType, DiffOptions, ErrorCode, Repository, Status, StatusOptions,
};
use serde::Serialize;
use tauri::async_runtime::spawn_blocking;

/// Run a synchronous closure off the Tauri worker pool. Every `pub fn`
/// command in this module used to block the worker thread while libgit2
/// walked the repo; with many projects open + an fs-watch storm, that
/// pool gets saturated and unrelated IPC (PTY input, etc.) stalls.
async fn run_blocking<T, E, F>(f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, E> + Send + 'static,
    T: Send + 'static,
    E: std::fmt::Display + Send + 'static,
{
    spawn_blocking(f)
        .await
        .map_err(|e| format!("join: {e}"))
        .and_then(|r| r.map_err(|e| e.to_string()))
}

/// Cap on concurrent libgit2 tree walks (`git_status` / `git_log` /
/// `git_overview`). Each walk transiently opens a fistful of fds — index,
/// refs, packfiles, and the recursive untracked-dir scan. With many
/// projects fs-watched at once, a single `npm build` or a busy agent fans a
/// `git_changed` burst across every repo simultaneously; without a cap
/// that's N parallel walks all grabbing fds + CPU, a transient spike that
/// was a contributing factor to the EMFILE wall. 4 lets a few panes refresh
/// in parallel while bounding the peak.
const GIT_WALK_CONCURRENCY: usize = 4;

async fn git_walk_permit() -> Result<tokio::sync::SemaphorePermit<'static>, String> {
    static S: std::sync::OnceLock<tokio::sync::Semaphore> = std::sync::OnceLock::new();
    S.get_or_init(|| tokio::sync::Semaphore::new(GIT_WALK_CONCURRENCY))
        .acquire()
        .await
        .map_err(|e| e.to_string())
}

// ---- helpers --------------------------------------------------------------

fn open_repo(path: &str) -> Result<Repository, String> {
    Repository::discover(path).map_err(|e| e.message().to_string())
}

fn run_git(repo: &str, args: &[&str]) -> Result<(bool, String, String), String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    Ok((
        out.status.success(),
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    ))
}

fn git_ok(repo: &str, args: &[&str]) -> Result<String, String> {
    let (ok, so, se) = run_git(repo, args)?;
    if ok {
        Ok(so)
    } else {
        Err(if se.trim().is_empty() { so } else { se })
    }
}

fn git_has_head(repo: &str) -> bool {
    git_ok(repo, &["rev-parse", "--verify", "HEAD"]).is_ok()
}

fn current_branch_name(repo: &str) -> Result<String, String> {
    let branch = git_ok(repo, &["branch", "--show-current"])?.trim().to_string();
    if branch.is_empty() {
        Err("Cannot operate on a detached HEAD — checkout a branch first.".into())
    } else {
        Ok(branch)
    }
}

fn remote_names(repo: &str) -> Result<Vec<String>, String> {
    Ok(git_ok(repo, &["remote"])?
        .lines()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned)
        .collect())
}

fn default_remote(repo: &str) -> Result<String, String> {
    let remotes = remote_names(repo)?;
    if remotes.iter().any(|r| r == "origin") {
        return Ok("origin".into());
    }
    if remotes.len() == 1 {
        return Ok(remotes[0].clone());
    }
    if remotes.is_empty() {
        Err("No git remotes configured — add a remote before publishing this branch.".into())
    } else {
        Err(format!(
            "No remote named origin. Pick/set an upstream from the remotes panel. Available remotes: {}",
            remotes.join(", ")
        ))
    }
}

fn has_upstream(repo: &str) -> bool {
    git_ok(repo, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false)
}

fn path_in_index(repo: &str, path: &str) -> bool {
    run_git(repo, &["ls-files", "--error-unmatch", "--", path])
        .map(|(ok, so, _)| ok && !so.trim().is_empty())
        .unwrap_or(false)
}

fn path_in_head(repo: &str, path: &str) -> bool {
    run_git(repo, &["ls-tree", "-r", "--name-only", "HEAD", "--", path])
        .map(|(ok, so, _)| ok && so.lines().any(|line| line == path))
        .unwrap_or(false)
}

// ---- types ----------------------------------------------------------------

#[derive(Serialize, Clone)]
pub struct GitFile {
    path: String,
    index: String,
    worktree: String,
}

#[derive(Serialize, Clone)]
pub struct GitStatus {
    branch: String,
    upstream: Option<String>,
    ahead: i32,
    behind: i32,
    files: Vec<GitFile>,
}

#[derive(Serialize, Clone)]
pub struct GitBranch {
    name: String,
    current: bool,
    upstream: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct GitCommit {
    /// Short, human-facing id (`8b075bd`).
    hash: String,
    /// Full oid — used by the frontend graph to match parents/children.
    full_hash: String,
    /// Full oids of this commit's parents (>1 == a merge).
    parents: Vec<String>,
    author: String,
    /// Stable key for the author colour chip (initials avatar).
    author_email: String,
    date: String,
    subject: String,
    /// Ref decorations pointing at this commit: `HEAD`, local branches,
    /// `origin/main`, `tag: v0.1.11`. Rendered as lazygit-style badges.
    refs: Vec<String>,
    /// True when this commit is ahead of the current branch's upstream
    /// (reachable from HEAD but not from `@{u}`) — i.e. not yet pushed.
    /// Drives the unpushed-vs-pushed lane colour in the graph.
    unpushed: bool,
}

#[derive(Serialize)]
pub struct GitOverview {
    status: GitStatus,
    branches: Vec<GitBranch>,
    log: Vec<GitCommit>,
}

// ---- status ---------------------------------------------------------------

fn status_chars(s: Status) -> (char, char) {
    // map (index, worktree) to porcelain X / Y chars
    let mut x = ' ';
    let mut y = ' ';
    if s.contains(Status::INDEX_NEW) {
        x = 'A';
    } else if s.contains(Status::INDEX_MODIFIED) {
        x = 'M';
    } else if s.contains(Status::INDEX_DELETED) {
        x = 'D';
    } else if s.contains(Status::INDEX_RENAMED) {
        x = 'R';
    } else if s.contains(Status::INDEX_TYPECHANGE) {
        x = 'T';
    }

    if s.contains(Status::WT_NEW) {
        y = '?';
        if x == ' ' {
            x = '?';
        }
    } else if s.contains(Status::WT_MODIFIED) {
        y = 'M';
    } else if s.contains(Status::WT_DELETED) {
        y = 'D';
    } else if s.contains(Status::WT_RENAMED) {
        y = 'R';
    } else if s.contains(Status::WT_TYPECHANGE) {
        y = 'T';
    } else if s.contains(Status::CONFLICTED) {
        x = 'U';
        y = 'U';
    }

    (x, y)
}

fn read_status(repo: &Repository) -> Result<GitStatus, String> {
    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .renames_head_to_index(true);

    let mut status = GitStatus {
        branch: String::new(),
        upstream: None,
        ahead: 0,
        behind: 0,
        files: Vec::new(),
    };

    // branch + upstream tracking
    if let Ok(head) = repo.head() {
        if let Some(name) = head.shorthand() {
            status.branch = name.to_string();
        }
        if let Ok(branch) = repo.find_branch(&status.branch, BranchType::Local) {
            if let Ok(up) = branch.upstream() {
                if let Some(n) = up.name().ok().flatten() {
                    status.upstream = Some(n.to_string());
                }
                if let (Some(local_oid), Some(up_oid)) = (head.target(), up.get().target()) {
                    if let Ok((ahead, behind)) = repo.graph_ahead_behind(local_oid, up_oid) {
                        status.ahead = ahead as i32;
                        status.behind = behind as i32;
                    }
                }
            }
        }
    } else if let Ok(rname) = repo.head_detached() {
        if rname {
            status.branch = "HEAD".to_string();
        }
    }
    if status.branch.is_empty() {
        // unborn branch — pull from HEAD reference name
        if let Ok(reference) = repo.find_reference("HEAD") {
            if let Some(target) = reference.symbolic_target() {
                status.branch = target
                    .strip_prefix("refs/heads/")
                    .unwrap_or(target)
                    .to_string();
            }
        }
    }

    let statuses = repo
        .statuses(Some(&mut opts))
        .map_err(|e| e.message().to_string())?;
    for entry in statuses.iter() {
        let path = match entry.path() {
            Some(p) => p.to_string(),
            None => continue,
        };
        let (x, y) = status_chars(entry.status());
        if x == ' ' && y == ' ' {
            continue;
        }
        status.files.push(GitFile {
            path,
            index: x.to_string(),
            worktree: y.to_string(),
        });
    }
    Ok(status)
}

#[tauri::command]
pub async fn git_status(repo: String) -> Result<GitStatus, String> {
    let _permit = git_walk_permit().await?;
    run_blocking(move || read_status(&open_repo(&repo)?)).await
}

// ---- branches & log -------------------------------------------------------

fn read_branches(repo: &Repository) -> Result<Vec<GitBranch>, String> {
    // Lazygit-style ordering: current branch always at top, then everything
    // else sorted by most-recently-committed-on (so branches you've actually
    // touched recently float up over stale `main` / `master` copies).
    struct Row {
        branch: GitBranch,
        committed_at: i64,
        is_current: bool,
    }
    let mut rows: Vec<Row> = Vec::new();
    let iter = repo
        .branches(Some(BranchType::Local))
        .map_err(|e| e.message().to_string())?;
    for b in iter {
        let (branch, _) = match b {
            Ok(p) => p,
            Err(_) => continue,
        };
        let name = match branch.name() {
            Ok(Some(n)) => n.to_string(),
            _ => continue,
        };
        let upstream = branch
            .upstream()
            .ok()
            .and_then(|up| up.name().ok().flatten().map(String::from));
        let is_current = branch.is_head();
        // Tip-of-branch commit time; 0 if we can't resolve (won't push it
        // above a real branch — the sort prefers larger timestamps).
        let committed_at = branch
            .get()
            .peel_to_commit()
            .map(|c| c.time().seconds())
            .unwrap_or(0);
        rows.push(Row {
            branch: GitBranch {
                name,
                current: is_current,
                upstream,
            },
            committed_at,
            is_current,
        });
    }
    rows.sort_by(|a, b| {
        b.is_current
            .cmp(&a.is_current) // current = true sorts first
            .then(b.committed_at.cmp(&a.committed_at)) // newer first
            .then(a.branch.name.cmp(&b.branch.name)) // tie-break alphabetical
    });
    Ok(rows.into_iter().map(|r| r.branch).collect())
}

#[tauri::command]
pub async fn git_branches(repo: String) -> Result<Vec<GitBranch>, String> {
    run_blocking(move || read_branches(&open_repo(&repo)?)).await
}

fn relative_time(secs: i64) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let d = (now - secs).max(0);
    if d < 60 {
        return format!("{}s ago", d);
    }
    if d < 3600 {
        return format!("{}m ago", d / 60);
    }
    if d < 86400 {
        return format!("{}h ago", d / 3600);
    }
    if d < 86400 * 30 {
        return format!("{}d ago", d / 86400);
    }
    if d < 86400 * 365 {
        return format!("{}mo ago", d / (86400 * 30));
    }
    format!("{}y ago", d / (86400 * 365))
}

/// Map commit oid (full hex) → ref decorations (`HEAD`, local branches,
/// remote branches, tags). Built once per log read so the graph timeline
/// can render lazygit-style ref badges without N extra git calls.
fn build_ref_map(repo: &Repository) -> std::collections::HashMap<String, Vec<String>> {
    let mut map: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
    // HEAD first so it renders leftmost on its commit.
    if let Ok(head) = repo.head() {
        if let Some(oid) = head.target() {
            map.entry(oid.to_string())
                .or_default()
                .push("HEAD".to_string());
        }
    }
    if let Ok(refs) = repo.references() {
        for r in refs.flatten() {
            let name = match r.shorthand() {
                Some(n) => n.to_string(),
                None => continue,
            };
            // `HEAD` is handled above; `origin/HEAD` & friends are symbolic
            // pointers, not real branches — skip the noise.
            if name == "HEAD" || name.ends_with("/HEAD") {
                continue;
            }
            // peel_to_commit resolves annotated tags down to their commit.
            let oid = match r.peel_to_commit() {
                Ok(c) => c.id(),
                Err(_) => continue,
            };
            let label = if r.is_tag() {
                format!("tag: {name}")
            } else {
                name
            };
            map.entry(oid.to_string()).or_default().push(label);
        }
    }
    map
}

/// Set of commit oids that are ahead of the current branch's upstream —
/// reachable from HEAD but not from `@{u}`. Empty when HEAD is detached or
/// the branch has no upstream (nothing to compare against → all "pushed").
fn unpushed_set(repo: &Repository) -> std::collections::HashSet<String> {
    let mut set = std::collections::HashSet::new();
    let head = match repo.head() {
        Ok(h) => h,
        Err(_) => return set,
    };
    let head_oid = match head.target() {
        Some(o) => o,
        None => return set,
    };
    let upstream_oid = head
        .shorthand()
        .and_then(|name| repo.find_branch(name, BranchType::Local).ok())
        .and_then(|b| b.upstream().ok())
        .and_then(|u| u.get().target());
    let upstream_oid = match upstream_oid {
        Some(o) => o,
        None => return set,
    };
    let mut revwalk = match repo.revwalk() {
        Ok(r) => r,
        Err(_) => return set,
    };
    if revwalk.push(head_oid).is_err() || revwalk.hide(upstream_oid).is_err() {
        return set;
    }
    for oid in revwalk.flatten() {
        set.insert(oid.to_string());
    }
    set
}

fn read_log(repo: &Repository, limit: usize) -> Result<Vec<GitCommit>, String> {
    let mut revwalk = repo.revwalk().map_err(|e| e.message().to_string())?;
    if revwalk.push_head().is_err() {
        return Ok(Vec::new());
    }
    // Topological + time keeps first-parent chains contiguous so the graph
    // lanes read cleanly, while still showing newest commits first.
    revwalk
        .set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::TIME)
        .map_err(|e| e.message().to_string())?;
    let ref_map = build_ref_map(repo);
    let unpushed = unpushed_set(repo);
    let mut out = Vec::with_capacity(limit);
    for (i, oid) in revwalk.enumerate() {
        if i >= limit {
            break;
        }
        let oid = match oid {
            Ok(o) => o,
            Err(_) => continue,
        };
        let commit = match repo.find_commit(oid) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let short = commit
            .as_object()
            .short_id()
            .ok()
            .and_then(|b| b.as_str().map(String::from))
            .unwrap_or_else(|| oid.to_string()[..7].to_string());
        let full = oid.to_string();
        let refs = ref_map.get(&full).cloned().unwrap_or_default();
        let is_unpushed = unpushed.contains(&full);
        out.push(GitCommit {
            hash: short,
            full_hash: full,
            parents: commit.parent_ids().map(|p| p.to_string()).collect(),
            author: commit.author().name().unwrap_or("").to_string(),
            author_email: commit.author().email().unwrap_or("").to_string(),
            date: relative_time(commit.time().seconds()),
            subject: commit.summary().unwrap_or("").to_string(),
            unpushed: is_unpushed,
            refs,
        });
    }
    Ok(out)
}

#[tauri::command]
pub async fn git_log(repo: String) -> Result<Vec<GitCommit>, String> {
    let _permit = git_walk_permit().await?;
    run_blocking(move || read_log(&open_repo(&repo)?, 60)).await
}

#[tauri::command]
pub async fn git_overview(repo: String) -> Result<GitOverview, String> {
    let _permit = git_walk_permit().await?;
    run_blocking(move || -> Result<GitOverview, String> {
        let r = open_repo(&repo)?;
        Ok(GitOverview {
            status: read_status(&r)?,
            branches: read_branches(&r)?,
            log: read_log(&r, 60)?,
        })
    })
    .await
}

#[tauri::command]
pub async fn git_checkout(repo: String, branch: String) -> Result<(), String> {
    // git2 checkout is fiddly with working-tree handling — shell out.
    git_ok(&repo, &["checkout", &branch]).map(|_| ())
}

fn local_branch_exists(repo: &str, branch: &str) -> bool {
    git_ok(repo, &["show-ref", "--verify", "--quiet", &format!("refs/heads/{branch}")]).is_ok()
}

fn remote_branch_exists(repo: &str, remote: &str, branch: &str) -> bool {
    git_ok(repo, &["show-ref", "--verify", "--quiet", &format!("refs/remotes/{remote}/{branch}")]).is_ok()
}

fn normalize_branch_input(repo: &str, raw: &str) -> Result<(Option<String>, String), String> {
    let mut b = raw.trim().trim_start_matches("refs/heads/").to_string();
    if let Some(rest) = b.strip_prefix("refs/remotes/") {
        b = rest.to_string();
    }
    if b.is_empty() || b == "—" || b.eq_ignore_ascii_case("n/a") {
        return Err("No deployed branch to checkout for this environment.".into());
    }
    let remotes = remote_names(repo).unwrap_or_default();
    if let Some((maybe_remote, rest)) = b.split_once('/') {
        if remotes.iter().any(|r| r == maybe_remote) {
            return Ok((Some(maybe_remote.to_string()), rest.to_string()));
        }
    }
    Ok((None, b))
}

fn find_remote_branch(repo: &str, preferred: Option<&str>, branch: &str) -> Result<Option<String>, String> {
    let remotes = remote_names(repo)?;
    if let Some(r) = preferred {
        return Ok(remote_branch_exists(repo, r, branch).then(|| r.to_string()));
    }
    if remotes.iter().any(|r| r == "origin") && remote_branch_exists(repo, "origin", branch) {
        return Ok(Some("origin".into()));
    }
    let matches: Vec<String> = remotes
        .into_iter()
        .filter(|r| remote_branch_exists(repo, r, branch))
        .collect();
    match matches.as_slice() {
        [] => Ok(None),
        [one] => Ok(Some(one.clone())),
        many => Err(format!(
            "Branch {branch} exists on multiple remotes ({}). Checkout from the remotes panel to choose one.",
            many.join(", ")
        )),
    }
}

#[tauri::command]
pub async fn git_checkout_smart(repo: String, branch: String) -> Result<String, String> {
    run_blocking(move || -> Result<String, String> {
        let (preferred_remote, local) = normalize_branch_input(&repo, &branch)?;
        if local_branch_exists(&repo, &local) {
            git_ok(&repo, &["checkout", &local])?;
            return Ok(format!("checked out {local}"));
        }

        let mut remote = find_remote_branch(&repo, preferred_remote.as_deref(), &local)?;
        if remote.is_none() {
            match preferred_remote.as_deref() {
                Some(r) => {
                    let _ = git_ok(&repo, &["fetch", "--prune", r]);
                }
                None => {
                    let _ = git_ok(&repo, &["fetch", "--all", "--prune"]);
                }
            }
            remote = find_remote_branch(&repo, preferred_remote.as_deref(), &local)?;
        }
        let Some(remote) = remote else {
            return Err(format!("Branch {branch} was not found locally or on any remote after fetch."));
        };
        let full_ref = format!("{remote}/{local}");
        git_ok(&repo, &["checkout", "-b", &local, "--track", &full_ref])?;
        Ok(format!("checked out {local} tracking {full_ref}"))
    })
    .await
}

/// Create a new branch starting at `start_point` (default HEAD) and check it
/// out. Mirrors `git checkout -b name [start_point]` — the usual "branch
/// from where I am right now" flow.
#[tauri::command]
pub async fn git_branch_create(
    repo: String,
    name: String,
    start_point: Option<String>,
) -> Result<(), String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("branch name is empty".into());
    }
    let mut args: Vec<&str> = vec!["checkout", "-b", trimmed];
    if let Some(sp) = start_point.as_deref() {
        if !sp.is_empty() {
            args.push(sp);
        }
    }
    git_ok(&repo, &args).map(|_| ())
}

#[tauri::command]
pub async fn git_branch_delete(repo: String, name: String, force: bool) -> Result<(), String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("branch name is empty".into());
    }
    let flag = if force { "-D" } else { "-d" };
    git_ok(&repo, &["branch", flag, trimmed]).map(|_| ())
}

#[tauri::command]
pub async fn git_branch_rename(
    repo: String,
    old_name: String,
    new_name: String,
) -> Result<(), String> {
    let old_trimmed = old_name.trim();
    let new_trimmed = new_name.trim();
    if old_trimmed.is_empty() || new_trimmed.is_empty() {
        return Err("branch name is empty".into());
    }
    git_ok(&repo, &["branch", "-m", old_trimmed, new_trimmed]).map(|_| ())
}

/// Merge `branch` into the current HEAD with a merge commit (--no-ff so the
/// branch topology stays visible — common lazygit / Tower convention).
/// Returns the merge command output; conflict text comes back as the Err
/// for the caller to surface.
#[tauri::command]
pub async fn git_merge(repo: String, branch: String) -> Result<String, String> {
    let trimmed = branch.trim();
    if trimmed.is_empty() {
        return Err("branch name is empty".into());
    }
    git_ok(&repo, &["merge", "--no-ff", trimmed])
}

#[tauri::command]
pub async fn git_merge_squash(repo: String, branch: String) -> Result<String, String> {
    let trimmed = branch.trim();
    if trimmed.is_empty() {
        return Err("branch name is empty".into());
    }
    git_ok(&repo, &["merge", "--squash", trimmed])
}

#[tauri::command]
pub async fn git_reset(repo: String, rev: String, mode: String) -> Result<(), String> {
    let trimmed = rev.trim();
    if trimmed.is_empty() {
        return Err("revision is empty".into());
    }
    let flag = match mode.as_str() {
        "soft" => "--soft",
        "mixed" => "--mixed",
        "hard" => "--hard",
        other => return Err(format!("unknown reset mode: {other}")),
    };
    git_ok(&repo, &["reset", flag, trimmed]).map(|_| ())
}

#[tauri::command]
pub async fn git_revert(repo: String, rev: String) -> Result<(), String> {
    let trimmed = rev.trim();
    if trimmed.is_empty() {
        return Err("revision is empty".into());
    }
    git_ok(&repo, &["revert", "--no-edit", trimmed]).map(|_| ())
}

// ---- diff -----------------------------------------------------------------

fn write_diff_to_string(diff: &git2::Diff) -> Result<String, String> {
    let mut out = String::new();
    diff.print(DiffFormat::Patch, |_d, _h, line| {
        match line.origin_value() {
            DiffLineType::Context => out.push(' '),
            DiffLineType::Addition => out.push('+'),
            DiffLineType::Deletion => out.push('-'),
            DiffLineType::FileHeader | DiffLineType::HunkHeader | DiffLineType::Binary => {}
            _ => {}
        }
        out.push_str(std::str::from_utf8(line.content()).unwrap_or(""));
        true
    })
    .map_err(|e| e.message().to_string())?;
    Ok(out)
}

#[tauri::command]
pub async fn git_diff(repo: String, path: String, staged: bool) -> Result<String, String> {
    let r = open_repo(&repo)?;
    let mut opts = DiffOptions::new();
    opts.pathspec(&path).context_lines(3);

    if staged {
        let head_tree = r.head().ok().and_then(|h| h.peel_to_tree().ok());
        let diff = r
            .diff_tree_to_index(head_tree.as_ref(), None, Some(&mut opts))
            .map_err(|e| e.message().to_string())?;
        return write_diff_to_string(&diff);
    }

    let diff = r
        .diff_index_to_workdir(None, Some(&mut opts))
        .map_err(|e| e.message().to_string())?;
    let s = write_diff_to_string(&diff)?;
    if !s.trim().is_empty() {
        return Ok(s);
    }

    // Untracked — fall back to git no-index for parity with the old impl.
    let (_, so, _) = run_git(
        &repo,
        &[
            "diff",
            "--no-ext-diff",
            "--no-index",
            "--",
            "/dev/null",
            &path,
        ],
    )?;
    Ok(so)
}

// ---- staging --------------------------------------------------------------

#[tauri::command]
pub fn git_stage(repo: String, path: String) -> Result<(), String> {
    let r = open_repo(&repo)?;
    let mut index = r.index().map_err(|e| e.message().to_string())?;
    let p = Path::new(&path);
    // If the file is gone, stage the deletion; else add the worktree content.
    let abs = Path::new(&repo).join(p);
    if !abs.exists() {
        index.remove_path(p).map_err(|e| e.message().to_string())?;
    } else {
        index.add_path(p).map_err(|e| e.message().to_string())?;
    }
    index.write().map_err(|e| e.message().to_string())
}

#[tauri::command]
pub fn git_unstage(repo: String, path: String) -> Result<(), String> {
    let r = open_repo(&repo)?;
    let head_commit = r.head().and_then(|h| h.peel_to_commit()).ok();
    let result = if let Some(head) = head_commit {
        r.reset_default(Some(head.as_object()), [&path])
            .map_err(|e| e.message().to_string())
    } else {
        // Pre-first-commit — remove from index.
        let mut idx = r.index().map_err(|e| e.message().to_string())?;
        idx.remove_path(Path::new(&path))
            .map_err(|e| e.message().to_string())?;
        idx.write().map_err(|e| e.message().to_string())
    };
    result
}

#[tauri::command]
pub async fn git_stage_all(repo: String) -> Result<(), String> {
    let r = open_repo(&repo)?;
    let mut idx = r.index().map_err(|e| e.message().to_string())?;
    idx.add_all(["*"], git2::IndexAddOption::DEFAULT, None)
        .map_err(|e| e.message().to_string())?;
    // Also stage deletions.
    idx.update_all(["*"], None)
        .map_err(|e| e.message().to_string())?;
    idx.write().map_err(|e| e.message().to_string())
}

/// Reset every staged change back to HEAD — lazygit-style "unstage all".
/// Used by the `a` toggle in the files panel when everything is already
/// staged. Shells out to `git reset` because libgit2's mixed-reset path
/// is fiddlier than spawning the canonical command.
#[tauri::command]
pub async fn git_unstage_all(repo: String) -> Result<(), String> {
    git_ok(&repo, &["reset", "HEAD", "--"]).map(|_| ())
}

// ---- show / file_at -------------------------------------------------------

fn revparse_commit<'a>(repo: &'a Repository, rev: &str) -> Result<git2::Commit<'a>, String> {
    repo.revparse_single(rev)
        .and_then(|o| o.peel_to_commit())
        .map_err(|e| e.message().to_string())
}

#[tauri::command]
pub async fn git_show(repo: String, rev: String) -> Result<String, String> {
    // git2's diff doesn't render the message + stat block the way `git show`
    // does — shelling out here costs us nothing and keeps the UI identical.
    git_ok(&repo, &["show", "--no-ext-diff", "--stat", "-p", &rev])
}

// Content-addressed cache for immutable revs.
//
// LRU by insertion+touch order — entries fall off the front as new ones land
// at the back, capped at `FILE_AT_CACHE_CAP`. `LinkedHashMap` gives us O(1)
// move-to-back on each hit so the ordering stays meaningful.
const FILE_AT_CACHE_CAP: usize = 500;

type FileAtKey = (String, String, String);

fn file_at_cache() -> &'static Mutex<linked_hash_map::LinkedHashMap<FileAtKey, String>> {
    static C: std::sync::OnceLock<Mutex<linked_hash_map::LinkedHashMap<FileAtKey, String>>> =
        std::sync::OnceLock::new();
    C.get_or_init(|| Mutex::new(linked_hash_map::LinkedHashMap::new()))
}

fn is_immutable_rev(rev: &str) -> bool {
    let head = rev.split(|c| c == '~' || c == '^').next().unwrap_or(rev);
    head.len() >= 7 && head.chars().all(|c| c.is_ascii_hexdigit())
}

#[tauri::command]
pub async fn git_file_at(repo: String, rev: String, path: String) -> Result<String, String> {
    let cacheable = is_immutable_rev(&rev);
    let key = (repo.clone(), rev.clone(), path.clone());
    if cacheable {
        if let Ok(mut cache) = file_at_cache().lock() {
            if let Some(hit) = cache.get_refresh(&key).cloned() {
                return Ok(hit);
            }
        }
    }
    let cache_key = key.clone();
    run_blocking(move || -> Result<String, String> {
        let r = open_repo(&repo)?;
        let content = if rev == ":index" {
            let idx = r.index().map_err(|e| e.message().to_string())?;
            match idx.get_path(Path::new(&path), 0) {
                Some(entry) => {
                    let blob = r.find_blob(entry.id).map_err(|e| e.message().to_string())?;
                    String::from_utf8_lossy(blob.content()).into_owned()
                }
                None => String::new(),
            }
        } else {
            match revparse_commit(&r, &rev) {
                Ok(commit) => {
                    let tree = commit.tree().map_err(|e| e.message().to_string())?;
                    match tree.get_path(Path::new(&path)) {
                        Ok(entry) => {
                            let blob = r
                                .find_blob(entry.id())
                                .map_err(|e| e.message().to_string())?;
                            String::from_utf8_lossy(blob.content()).into_owned()
                        }
                        Err(e) if e.code() == ErrorCode::NotFound => String::new(),
                        Err(e) => return Err(e.message().to_string()),
                    }
                }
                Err(_) => String::new(),
            }
        };
        if cacheable {
            if let Ok(mut cache) = file_at_cache().lock() {
                cache.insert(cache_key, content.clone());
                while cache.len() > FILE_AT_CACHE_CAP {
                    cache.pop_front();
                }
            }
        }
        Ok(content)
    })
    .await
}

#[tauri::command]
pub async fn git_commit_files(repo: String, rev: String) -> Result<Vec<String>, String> {
    let r = open_repo(&repo)?;
    let commit = revparse_commit(&r, &rev)?;
    let new_tree = commit.tree().map_err(|e| e.message().to_string())?;
    let parent_tree = commit.parent(0).ok().and_then(|p| p.tree().ok());
    let diff = r
        .diff_tree_to_tree(parent_tree.as_ref(), Some(&new_tree), None)
        .map_err(|e| e.message().to_string())?;
    let mut paths = Vec::new();
    diff.foreach(
        &mut |d, _| {
            if let Some(p) = d.new_file().path().or_else(|| d.old_file().path()) {
                let s = p.to_string_lossy().into_owned();
                if !paths.contains(&s) {
                    paths.push(s);
                }
            }
            true
        },
        None,
        None,
        None,
    )
    .map_err(|e| e.message().to_string())?;
    Ok(paths)
}

// ---- blame ----------------------------------------------------------------

#[derive(Serialize, Clone)]
pub struct BlameCommit {
    /// Full commit oid; all-zeros for not-yet-committed lines.
    sha: String,
    /// Short id for display (`1d3fa0b2`); empty when uncommitted.
    short: String,
    author: String,
    author_email: String,
    /// Pre-formatted relative time (`3 days ago`); empty when uncommitted.
    time: String,
    /// Raw author timestamp (unix seconds) — kept so the UI can re-format.
    timestamp: i64,
    summary: String,
    /// True for lines that only exist in the working buffer (zero sha).
    uncommitted: bool,
}

/// Compact per-file blame: the unique commits touched, plus a parallel array
/// mapping each 0-based line to its commit's index in `commits`. The split
/// keeps the IPC payload small (commit metadata isn't repeated per line) and
/// lets the editor do O(1) cursor-line lookups with no further backend calls.
#[derive(Serialize, Default)]
pub struct GitBlame {
    commits: Vec<BlameCommit>,
    lines: Vec<u32>,
}

fn is_zero_sha(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b == b'0')
}

/// Parse `git blame --porcelain`. Commit metadata is emitted only the first
/// time each commit appears, so we accumulate it keyed by sha and remember
/// first-seen order for stable indices.
fn parse_blame_porcelain(out: &str) -> GitBlame {
    use std::collections::HashMap;

    struct Meta {
        author: String,
        author_email: String,
        timestamp: i64,
        summary: String,
    }

    let mut meta: HashMap<String, Meta> = HashMap::new();
    let mut index_of: HashMap<String, u32> = HashMap::new();
    let mut order: Vec<String> = Vec::new();
    let mut line_sha: Vec<(usize, String)> = Vec::new();

    let mut cur = String::new();
    let mut cur_line = 0usize;
    let mut max_line = 0usize;

    for line in out.lines() {
        // Content line — closes the entry for the line we last saw a header for.
        if let Some(_content) = line.strip_prefix('\t') {
            if !cur.is_empty() && cur_line > 0 {
                line_sha.push((cur_line, cur.clone()));
                if cur_line > max_line {
                    max_line = cur_line;
                }
            }
            continue;
        }

        // Header: "<40-hex-sha> <orig-line> <final-line> [<group-count>]".
        let b = line.as_bytes();
        let is_header =
            b.len() > 40 && b[40] == b' ' && b[..40].iter().all(|c| c.is_ascii_hexdigit());
        if is_header {
            let mut parts = line.split(' ');
            let sha = parts.next().unwrap_or("").to_string();
            let _orig = parts.next();
            cur_line = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
            cur = sha.clone();
            if !index_of.contains_key(&sha) {
                index_of.insert(sha.clone(), order.len() as u32);
                order.push(sha.clone());
                meta.insert(
                    sha,
                    Meta {
                        author: String::new(),
                        author_email: String::new(),
                        timestamp: 0,
                        summary: String::new(),
                    },
                );
            }
            continue;
        }

        // Metadata line for the current commit.
        if let Some(rest) = line.strip_prefix("author ") {
            if let Some(m) = meta.get_mut(&cur) {
                m.author = rest.to_string();
            }
        } else if let Some(rest) = line.strip_prefix("author-mail ") {
            if let Some(m) = meta.get_mut(&cur) {
                m.author_email = rest.trim_matches(|c| c == '<' || c == '>').to_string();
            }
        } else if let Some(rest) = line.strip_prefix("author-time ") {
            if let Some(m) = meta.get_mut(&cur) {
                m.timestamp = rest.trim().parse().unwrap_or(0);
            }
        } else if let Some(rest) = line.strip_prefix("summary ") {
            if let Some(m) = meta.get_mut(&cur) {
                m.summary = rest.to_string();
            }
        }
    }

    let commits: Vec<BlameCommit> = order
        .iter()
        .map(|sha| {
            let m = &meta[sha];
            let uncommitted = is_zero_sha(sha);
            BlameCommit {
                sha: sha.clone(),
                short: if uncommitted {
                    String::new()
                } else {
                    sha[..8.min(sha.len())].to_string()
                },
                author: if uncommitted {
                    "You".to_string()
                } else {
                    m.author.clone()
                },
                author_email: m.author_email.clone(),
                time: if uncommitted {
                    String::new()
                } else {
                    relative_time(m.timestamp)
                },
                timestamp: m.timestamp,
                summary: if uncommitted {
                    "Uncommitted changes".to_string()
                } else {
                    m.summary.clone()
                },
                uncommitted,
            }
        })
        .collect();

    let mut lines = vec![0u32; max_line];
    for (ln, sha) in line_sha {
        if ln >= 1 && ln <= max_line {
            if let Some(&idx) = index_of.get(&sha) {
                lines[ln - 1] = idx;
            }
        }
    }

    GitBlame { commits, lines }
}

/// Blame a single file. When `contents` is provided we blame that buffer via
/// `--contents -` so unsaved editor edits line up correctly (those lines come
/// back as the zero-sha "uncommitted" commit). Untracked / no-HEAD / binary
/// files have nothing to blame and yield an empty result rather than an error
/// so the editor just shows no inline blame.
#[tauri::command]
pub async fn git_blame(
    repo: String,
    path: String,
    contents: Option<String>,
) -> Result<GitBlame, String> {
    let _permit = git_walk_permit().await?;
    run_blocking(move || -> Result<GitBlame, String> {
        let out = match contents {
            Some(text) => {
                let mut child = Command::new("git")
                    .arg("-C")
                    .arg(&repo)
                    .args(["blame", "--porcelain", "--contents", "-", "--", &path])
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .spawn()
                    .map_err(|e| e.to_string())?;
                child
                    .stdin
                    .take()
                    .ok_or("no stdin")?
                    .write_all(text.as_bytes())
                    .map_err(|e| e.to_string())?;
                let o = child.wait_with_output().map_err(|e| e.to_string())?;
                if !o.status.success() {
                    return Ok(GitBlame::default());
                }
                String::from_utf8_lossy(&o.stdout).into_owned()
            }
            None => {
                let (ok, so, _se) = run_git(&repo, &["blame", "--porcelain", "--", &path])?;
                if !ok {
                    return Ok(GitBlame::default());
                }
                so
            }
        };
        Ok(parse_blame_porcelain(&out))
    })
    .await
}

// ---- commit / push / pull -------------------------------------------------

fn commit_with_message(repo: &str, message: &str) -> Result<String, String> {
    let mut child = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["commit", "-F", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    child
        .stdin
        .take()
        .ok_or("no stdin")?
        .write_all(message.as_bytes())
        .map_err(|e| e.to_string())?;
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).into_owned())
    }
}

#[tauri::command]
pub async fn git_commit(repo: String, message: String) -> Result<String, String> {
    run_blocking(move || commit_with_message(&repo, &message)).await
}

#[tauri::command]
pub async fn git_push(repo: String) -> Result<String, String> {
    run_blocking(move || -> Result<String, String> {
        let branch = current_branch_name(&repo)?;
        if !has_upstream(&repo) {
            let remote = default_remote(&repo)?;
            let (ok, so, se) = run_git(&repo, &["push", "--set-upstream", &remote, &branch])?;
            return if ok {
                let out = format!("{so}{se}").trim().to_string();
                Ok(if out.is_empty() {
                    format!("published {branch} → {remote}/{branch}")
                } else {
                    format!("published {branch} → {remote}/{branch}\n{out}")
                })
            } else {
                Err(if se.trim().is_empty() { so } else { se })
            };
        }

        let (ok, so, se) = run_git(&repo, &["push"])?;
        if ok {
            return Ok(format!("{so}{se}").trim().to_string());
        }
        // Race-proof fallback: if upstream disappeared between the preflight
        // check and push, publish with -u instead of dumping raw Git advice.
        if se.contains("has no upstream branch") || se.contains("--set-upstream") {
            let remote = default_remote(&repo)?;
            let (ok2, so2, se2) = run_git(&repo, &["push", "--set-upstream", &remote, &branch])?;
            return if ok2 {
                Ok(format!("published {branch} → {remote}/{branch}\n{}", format!("{so2}{se2}").trim()))
            } else {
                Err(if se2.trim().is_empty() { so2 } else { se2 })
            };
        }
        Err(if se.trim().is_empty() { so } else { se })
    })
    .await
}

fn looks_like_ff_only_divergence(stderr: &str) -> bool {
    let s = stderr.to_ascii_lowercase();
    s.contains("not possible to fast-forward")
        || s.contains("divergent branches")
        || s.contains("need to specify how to reconcile")
        || s.contains("fatal: not possible to fast-forward")
}

#[tauri::command]
pub async fn git_pull(repo: String) -> Result<String, String> {
    run_blocking(move || -> Result<String, String> {
        if !has_upstream(&repo) {
            return Err("No upstream configured for this branch — publish it or set an upstream from the remotes panel first.".into());
        }
        let (ok, so, se) = run_git(&repo, &["pull", "--ff-only"])?;
        if ok {
            return Ok(format!("{so}{se}").trim().to_string());
        }
        let err = format!("{so}{se}");
        if !looks_like_ff_only_divergence(&err) {
            return Err(err.trim().to_string());
        }

        // Git 2.27+ asks users to configure pull.rebase for divergent pulls.
        // Do the app-level sane default instead: rebase with autostash, without
        // mutating the user's global config.
        let (ok2, so2, se2) = run_git(&repo, &["pull", "--rebase", "--autostash"])?;
        if ok2 {
            let out = format!("{so2}{se2}").trim().to_string();
            Ok(if out.is_empty() { "rebased onto upstream".into() } else { format!("rebased onto upstream\n{out}") })
        } else {
            Err(format!(
                "Fast-forward was not possible, and rebase needs attention. Resolve in the git pane or terminal, then continue the rebase.\n\n{}",
                format!("{so2}{se2}").trim()
            ))
        }
    })
    .await
}

// ---- AI commit ------------------------------------------------------------

const DIFF_LIMIT: usize = 50_000;

fn clean_commit_message(raw: &str) -> Result<String, String> {
    let mut t = raw.trim().to_string();
    if t.starts_with("```") {
        if let Some(nl) = t.find('\n') {
            t = t[nl + 1..].to_string();
        }
    }
    let te = t.trim_end();
    if te.ends_with("```") {
        t = te[..te.len() - 3].to_string();
    }
    const CONV: [&str; 11] = [
        "feat", "fix", "refactor", "chore", "docs", "test", "perf", "build", "ci", "style",
        "revert",
    ];
    let mut lines: Vec<&str> = t.lines().collect();
    while let Some(first) = lines.first() {
        let f = first.trim();
        let is_conv = CONV.iter().any(|p| {
            f.strip_prefix(p)
                .map(|r| r.starts_with(':') || r.starts_with('(') || r.starts_with('!'))
                .unwrap_or(false)
        });
        if is_conv {
            break;
        }
        lines.remove(0);
    }
    while lines.last().map(|l| l.trim().is_empty()).unwrap_or(false) {
        lines.pop();
    }
    if lines.is_empty() {
        return Err("AI returned no usable commit message".into());
    }
    Ok(lines.join("\n"))
}

#[derive(Clone, Copy)]
enum GitAiProvider {
    Hermes,
    Codex,
    Claude,
}

impl GitAiProvider {
    fn parse(raw: Option<String>) -> Result<Self, String> {
        match raw
            .as_deref()
            .unwrap_or("hermes")
            .trim()
            .to_ascii_lowercase()
            .as_str()
        {
            "" | "hermes" => Ok(Self::Hermes),
            "codex" => Ok(Self::Codex),
            "claude" => Ok(Self::Claude),
            other => Err(format!("unknown AI commit provider: {other}")),
        }
    }

    fn bin(self) -> &'static str {
        match self {
            Self::Hermes => "hermes",
            Self::Codex => "codex",
            Self::Claude => "claude",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Hermes => "hermes",
            Self::Codex => "codex",
            Self::Claude => "claude",
        }
    }

    fn default_model(self) -> &'static str {
        match self {
            Self::Hermes => "openai/gpt-5.5",
            Self::Codex => "gpt-5.5",
            Self::Claude => "sonnet",
        }
    }
}

fn command_candidates(name: &str) -> Vec<String> {
    let home = std::env::var("HOME").unwrap_or_default();
    vec![
        name.to_string(),
        format!("{home}/.local/bin/{name}"),
        format!("{home}/.cargo/bin/{name}"),
        format!("{home}/.opencode/bin/{name}"),
        format!("/opt/homebrew/bin/{name}"),
        format!("/usr/local/bin/{name}"),
    ]
}

fn run_ai_candidate<F>(
    provider: GitAiProvider,
    stdin_text: Option<&str>,
    mut build: F,
) -> Result<String, String>
where
    F: FnMut(&str) -> Command,
{
    for bin in command_candidates(provider.bin()) {
        let mut cmd = build(&bin);
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
        if stdin_text.is_some() {
            cmd.stdin(Stdio::piped());
        }
        match cmd.spawn() {
            Ok(mut child) => {
                if let Some(text) = stdin_text {
                    child
                        .stdin
                        .take()
                        .ok_or("no stdin")?
                        .write_all(text.as_bytes())
                        .map_err(|e| e.to_string())?;
                }
                let out = child.wait_with_output().map_err(|e| e.to_string())?;
                if out.status.success() {
                    return Ok(String::from_utf8_lossy(&out.stdout).into_owned());
                }
                let stderr = String::from_utf8_lossy(&out.stderr);
                let stdout = String::from_utf8_lossy(&out.stdout);
                let detail = if stderr.trim().is_empty() {
                    stdout.trim()
                } else {
                    stderr.trim()
                };
                return Err(format!("{} failed: {detail}", provider.label()));
            }
            Err(e) if e.kind() == ErrorKind::NotFound => continue,
            Err(e) => return Err(format!("{} failed: {e}", provider.label())),
        }
    }
    Err(format!("{} not found on PATH", provider.bin()))
}

fn run_ai_commit_model(
    repo: &str,
    provider: GitAiProvider,
    model: &str,
    prompt: &str,
) -> Result<String, String> {
    let model = if model.trim().is_empty() {
        provider.default_model()
    } else {
        model.trim()
    };
    match provider {
        GitAiProvider::Hermes => run_ai_candidate(provider, None, |bin| {
            let mut cmd = Command::new(bin);
            cmd.current_dir(repo)
                .args(["chat", "-Q", "-m", model, "-t", "safe", "-q", prompt]);
            cmd
        }),
        // `codex exec` is the non-interactive path — it has no
        // `--ask-for-approval` (that's interactive-only); `--sandbox read-only`
        // is enough for a read-only generate. Prompt is piped via stdin (`-`).
        GitAiProvider::Codex => run_ai_candidate(provider, Some(prompt), |bin| {
            let mut cmd = Command::new(bin);
            cmd.current_dir(repo).args([
                "exec",
                "-m",
                model,
                "-C",
                repo,
                "--sandbox",
                "read-only",
                "--skip-git-repo-check",
                "--ephemeral",
                "--color",
                "never",
                "-",
            ]);
            cmd
        }),
        // Feed the prompt over stdin (not as a positional arg) — claude's
        // `--print` mode reads stdin, and passing the prompt as an argument
        // alongside flags is brittle (it gets misparsed → "Input must be
        // provided either through stdin or as a prompt argument").
        GitAiProvider::Claude => run_ai_candidate(provider, Some(prompt), |bin| {
            let mut cmd = Command::new(bin);
            cmd.current_dir(repo)
                .args(["--print", "--model", model, "--output-format", "text"]);
            cmd
        }),
    }
}

/// Build the AI prompt from a stat + diff. Shared by the generate-only
/// (`git_ai_message`) and stage-and-commit (`git_ai_commit`) paths so the
/// message style stays identical.
fn commit_message_prompt(repo: &str, stat: &str, diff: &str) -> String {
    let branch = git_ok(repo, &["branch", "--show-current"])
        .unwrap_or_default()
        .trim()
        .to_string();
    let repo_name = std::path::Path::new(repo)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    format!(
        "You are generating a Git commit message from the staged diff below.\n\
         Return ONLY the commit message. No markdown, no explanation, no quotes, no code fences.\n\n\
         Rules:\n\
         - First line: conventional commit format: type(scope): subject\n\
         - Imperative mood, no trailing period, <=72 chars if possible\n\
         - For trivial changes: subject line only\n\
         - For non-trivial changes: blank line after subject, then 2-6 bullets starting with \"- \"\n\
         - Common types: feat, fix, refactor, chore, docs, test, perf, build, ci, style\n\
         - Scope should be short and inferred from files/package/service when obvious; omit scope if unclear\n\n\
         Repo: {repo_name}\n\
         Branch: {branch}\n\n\
         Staged stat:\n{stat}\n\n\
         Staged diff:\n{diff}\n"
    )
}

/// Truncate an over-long diff so the prompt stays within budget.
fn cap_diff(mut diff: String) -> String {
    if diff.len() > DIFF_LIMIT {
        diff.truncate(DIFF_LIMIT);
        diff.push_str("\n\n[diff truncated — exceeds size limit]\n");
    }
    diff
}

fn staged_diff(repo: &str) -> Result<(String, String), String> {
    Ok((
        git_ok(repo, &["diff", "--cached", "--stat"])?,
        git_ok(repo, &["diff", "--cached", "--no-ext-diff", "--unified=3"])?,
    ))
}

fn worktree_diff(repo: &str) -> Result<(String, String), String> {
    if git_has_head(repo) {
        Ok((
            git_ok(repo, &["diff", "HEAD", "--stat"])?,
            git_ok(repo, &["diff", "HEAD", "--no-ext-diff", "--unified=3"])?,
        ))
    } else {
        Ok((
            git_ok(repo, &["diff", "--stat"])?,
            git_ok(repo, &["diff", "--no-ext-diff", "--unified=3"])?,
        ))
    }
}

/// Generate a commit message WITHOUT staging or committing — backs the `✦`
/// button + the `g` keybinding. Prefers the staged diff; if nothing's
/// staged, falls back to the full working-tree diff so it still works
/// before you stage anything.
#[tauri::command]
pub async fn git_ai_message(
    repo: String,
    provider: Option<String>,
    model: Option<String>,
) -> Result<String, String> {
    let (mut stat, mut diff) = staged_diff(&repo)?;
    if diff.trim().is_empty() {
        (stat, diff) = worktree_diff(&repo)?;
    }
    if diff.trim().is_empty() {
        return Err("Nothing to describe — stage changes or edit some files first.".into());
    }
    let diff = cap_diff(diff);
    let prompt = commit_message_prompt(&repo, &stat, &diff);
    let provider = GitAiProvider::parse(provider)?;
    let model = model.unwrap_or_else(|| provider.default_model().to_string());
    clean_commit_message(&run_ai_commit_model(&repo, provider, &model, &prompt)?)
}

#[tauri::command]
pub async fn git_ai_commit(
    repo: String,
    provider: Option<String>,
    model: Option<String>,
) -> Result<String, String> {
    // Auto-stage all working changes if nothing's been staged yet — pressing
    // Shift+C should "just commit," matching VSCode / Cursor's AI-commit UX.
    if git_ok(&repo, &["diff", "--cached", "--name-only"])?
        .trim()
        .is_empty()
    {
        git_ok(&repo, &["add", "-A"])?;
        if git_ok(&repo, &["diff", "--cached", "--name-only"])?
            .trim()
            .is_empty()
        {
            return Err("Nothing to commit — working tree is clean.".into());
        }
    }
    let (stat, diff) = staged_diff(&repo)?;
    let diff = cap_diff(diff);
    let prompt = commit_message_prompt(&repo, &stat, &diff);

    let provider = GitAiProvider::parse(provider)?;
    let model = model.unwrap_or_else(|| provider.default_model().to_string());
    let message = clean_commit_message(&run_ai_commit_model(&repo, provider, &model, &prompt)?)?;
    commit_with_message(&repo, &message)?;
    Ok(message)
}

// ---- open PR --------------------------------------------------------------

#[tauri::command]
pub async fn pr_open(repo: String) -> Result<String, String> {
    let r = open_repo(&repo)?;
    let remote_url = r
        .find_remote("origin")
        .map_err(|e| e.message().to_string())?
        .url()
        .ok_or("origin has no URL")?
        .to_string();

    let branch = r
        .head()
        .ok()
        .and_then(|h| h.shorthand().map(String::from))
        .ok_or("no current branch (detached HEAD?)")?;

    let mut url = if let Some(rest) = remote_url.strip_prefix("git@") {
        match rest.split_once(':') {
            Some((host, path)) => format!("https://{host}/{}", path.trim_end_matches(".git")),
            None => remote_url.clone(),
        }
    } else {
        remote_url.trim_end_matches(".git").to_string()
    };

    if url.contains("github.com") {
        url = format!("{url}/compare/{branch}?expand=1");
    } else if url.contains("bitbucket.org") {
        url = format!("{url}/pull-requests/new?source={branch}");
    } else {
        return Err(format!("unsupported remote host: {url}"));
    }

    Command::new("open")
        .arg(&url)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(url)
}

// ---- discard --------------------------------------------------------------

/// Discard changes to a single file. `mode`:
///   - "unstaged"       → revert working tree to match the index
///                        (= `git restore --worktree <path>`). Staged changes are
///                        preserved.
///   - "staged"         → unstage but leave the worktree alone
///                        (= `git restore --staged <path>`).
///   - "all"            → discard staged AND unstaged changes: first
///                        unstage, then restore. For untracked files this
///                        deletes the file (= `git clean -f <path>`).
///
/// For new (untracked) files, "unstaged" and "all" both remove the file
/// since there's no index or HEAD version to restore from.
#[tauri::command]
pub async fn git_discard_file(repo: String, path: String, mode: String) -> Result<(), String> {
    match mode.as_str() {
        "staged" => {
            git_ok(&repo, &["restore", "--staged", "--", &path])
                .or_else(|_| git_ok(&repo, &["reset", "HEAD", "--", &path]))
                .or_else(|_| git_ok(&repo, &["rm", "--cached", "--ignore-unmatch", "--", &path]))?;
        }
        "unstaged" => {
            if path_in_index(&repo, &path) {
                // Restore the worktree from the index, preserving staged
                // content. `checkout HEAD -- path` would also wipe staged edits.
                git_ok(&repo, &["restore", "--worktree", "--", &path])?;
            } else {
                git_ok(&repo, &["clean", "-f", "--", &path])?;
            }
        }
        "all" => {
            let _ = git_ok(&repo, &["restore", "--staged", "--", &path])
                .or_else(|_| git_ok(&repo, &["reset", "HEAD", "--", &path]));
            if path_in_head(&repo, &path) {
                git_ok(&repo, &["restore", "--worktree", "--", &path])?;
            } else {
                git_ok(&repo, &["clean", "-f", "--", &path])?;
            }
        }
        other => return Err(format!("unknown discard mode: {other}")),
    }
    Ok(())
}

// ---- stash ---------------------------------------------------------------

#[derive(Serialize, Clone)]
pub struct GitStash {
    /// Reflog index (0 = top). We treat this as the stable id within a
    /// single session, but it shifts whenever the user drops/pops, so
    /// the UI re-reads after every mutation.
    index: usize,
    /// Stash commit id. This is the stable guard used before apply/pop/drop so
    /// external stash-list edits cannot make a stale UI row target another stash.
    sha: String,
    /// `stash@{N}` — the symbolic ref form, useful for `git stash apply <ref>`.
    refname: String,
    /// Branch name the stash was created from.
    branch: String,
    /// Free-form message (usually `WIP on <branch>: <sha> <subject>`).
    message: String,
}

#[tauri::command]
pub async fn git_stash_list(repo: String) -> Result<Vec<GitStash>, String> {
    // Format chosen so we don't depend on lazy field parsing — `%gd` is
    // the selector (`stash@{N}`), `%gs` is the message. We compute branch
    // from the message prefix (`WIP on <branch>:` / `On <branch>:`).
    let out = git_ok(&repo, &["stash", "list", "--format=%H%x09%gd%x09%gs"])?;
    let mut entries = Vec::new();
    for (idx, line) in out.lines().enumerate() {
        let mut parts = line.splitn(3, '\t');
        let sha = parts.next().unwrap_or("").to_string();
        let refname = parts.next().unwrap_or("").to_string();
        let message = parts.next().unwrap_or("").to_string();
        let branch = parse_stash_branch(&message);
        entries.push(GitStash {
            index: idx,
            sha,
            refname,
            branch,
            message,
        });
    }
    Ok(entries)
}

fn parse_stash_branch(message: &str) -> String {
    // `WIP on foo: 1234abc subject` or `On foo: custom message`
    let stripped = message
        .strip_prefix("WIP on ")
        .or_else(|| message.strip_prefix("On "))
        .unwrap_or(message);
    stripped.split(':').next().unwrap_or("").trim().to_string()
}

fn resolve_stash_ref(repo: &str, refname: &str, expected_sha: &str) -> Result<String, String> {
    let cur_sha = git_ok(repo, &["rev-parse", refname])
        .unwrap_or_default()
        .trim()
        .to_string();
    if !expected_sha.is_empty() && cur_sha == expected_sha {
        return Ok(refname.to_string());
    }

    let out = git_ok(repo, &["stash", "list", "--format=%H%x09%gd"])?;
    for line in out.lines() {
        let mut parts = line.splitn(2, '\t');
        let sha = parts.next().unwrap_or("");
        let name = parts.next().unwrap_or("");
        if sha == expected_sha && !name.is_empty() {
            return Ok(name.to_string());
        }
    }

    if expected_sha.is_empty() && !cur_sha.is_empty() {
        return Ok(refname.to_string());
    }
    Err(format!(
        "stash {refname} changed or no longer exists; refresh the stash list"
    ))
}

/// Create a new stash. `mode`:
///   - "all" (default)     → `git stash push -u` (includes untracked).
///   - "staged"            → `git stash push --staged`.
///   - "unstaged"          → `git stash push --keep-index` then a fixup
///                           that leaves only the unstaged work in the
///                           stash. Implemented as `--keep-index` since
///                           that's the closest single-command match.
#[tauri::command]
pub async fn git_stash_push(
    repo: String,
    message: Option<String>,
    mode: String,
) -> Result<(), String> {
    let mut args: Vec<String> = vec!["stash".into(), "push".into()];
    match mode.as_str() {
        "all" => {
            args.push("-u".into());
        }
        "staged" => {
            args.push("--staged".into());
        }
        "unstaged" => {
            args.push("--keep-index".into());
        }
        other => return Err(format!("unknown stash mode: {other}")),
    }
    if let Some(m) = message {
        if !m.trim().is_empty() {
            args.push("-m".into());
            args.push(m);
        }
    }
    let str_args: Vec<&str> = args.iter().map(String::as_str).collect();
    git_ok(&repo, &str_args)?;
    Ok(())
}

#[tauri::command]
pub async fn git_stash_apply(repo: String, refname: String, sha: String) -> Result<(), String> {
    let r = resolve_stash_ref(&repo, &refname, &sha)?;
    git_ok(&repo, &["stash", "apply", &r])?;
    Ok(())
}

#[tauri::command]
pub async fn git_stash_pop(repo: String, refname: String, sha: String) -> Result<(), String> {
    let r = resolve_stash_ref(&repo, &refname, &sha)?;
    git_ok(&repo, &["stash", "pop", &r])?;
    Ok(())
}

#[tauri::command]
pub async fn git_stash_drop(repo: String, refname: String, sha: String) -> Result<(), String> {
    let r = resolve_stash_ref(&repo, &refname, &sha)?;
    git_ok(&repo, &["stash", "drop", &r])?;
    Ok(())
}

#[tauri::command]
pub async fn git_stash_branch(
    repo: String,
    refname: String,
    sha: String,
    name: String,
) -> Result<(), String> {
    let r = resolve_stash_ref(&repo, &refname, &sha)?;
    git_ok(&repo, &["stash", "branch", &name, &r])?;
    Ok(())
}

#[tauri::command]
pub async fn git_stash_rename(
    repo: String,
    refname: String,
    sha: String,
    new_message: String,
) -> Result<(), String> {
    // No native `git stash rename` — drop + stash store with the new
    // message preserves the stash content while replacing its label.
    let r = resolve_stash_ref(&repo, &refname, &sha)?;
    // Grab the underlying commit SHA for the stash so we can re-store.
    let sha = git_ok(&repo, &["rev-parse", &r])?.trim().to_string();
    if sha.is_empty() {
        return Err(format!("could not resolve {r}"));
    }
    git_ok(&repo, &["stash", "drop", &r])?;
    git_ok(&repo, &["stash", "store", "-m", &new_message, &sha])?;
    Ok(())
}

// ---- remotes -------------------------------------------------------------

#[derive(Serialize, Clone)]
pub struct GitRemote {
    pub name: String,
    /// Fetch URL — the one we display + use for cloning context.
    pub url: String,
}

/// `git remote -v` shape: `<name>\t<url> (fetch|push)` per line. We keep
/// only the fetch URL since that's authoritative for branch listing.
#[tauri::command]
pub async fn git_remotes(repo: String) -> Result<Vec<GitRemote>, String> {
    let out = git_ok(&repo, &["remote", "-v"])?;
    let mut seen: std::collections::HashMap<String, String> = Default::default();
    for line in out.lines() {
        // Format: "origin\tgit@github.com:foo/bar.git (fetch)"
        let mut parts = line.split('\t');
        let name = parts.next().unwrap_or("").trim().to_string();
        let rest = parts.next().unwrap_or("");
        if name.is_empty() || rest.is_empty() {
            continue;
        }
        // Only keep fetch URLs.
        let is_fetch = rest.trim_end().ends_with("(fetch)");
        if !is_fetch {
            continue;
        }
        let url = rest.rsplitn(2, ' ').nth(1).unwrap_or("").trim().to_string();
        if !url.is_empty() {
            seen.insert(name, url);
        }
    }
    let mut list: Vec<GitRemote> = seen
        .into_iter()
        .map(|(name, url)| GitRemote { name, url })
        .collect();
    list.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(list)
}

#[tauri::command]
pub async fn git_remote_add(repo: String, name: String, url: String) -> Result<(), String> {
    git_ok(&repo, &["remote", "add", &name, &url])?;
    Ok(())
}

#[tauri::command]
pub async fn git_remote_remove(repo: String, name: String) -> Result<(), String> {
    git_ok(&repo, &["remote", "remove", &name])?;
    Ok(())
}

#[tauri::command]
pub async fn git_remote_rename(
    repo: String,
    old_name: String,
    new_name: String,
) -> Result<(), String> {
    git_ok(&repo, &["remote", "rename", &old_name, &new_name])?;
    Ok(())
}

#[tauri::command]
pub async fn git_remote_set_url(repo: String, name: String, url: String) -> Result<(), String> {
    git_ok(&repo, &["remote", "set-url", &name, &url])?;
    Ok(())
}

/// Fetch a single remote when `remote` is set, otherwise `--all`. Always
/// passes `--prune` so stale remote-tracking branches get reaped — this
/// matches lazygit's default and avoids the "branch shows up after it was
/// deleted upstream" trap.
#[tauri::command]
pub async fn git_fetch(repo: String, remote: Option<String>) -> Result<String, String> {
    run_blocking(move || -> Result<String, String> {
        let out = match remote {
            Some(r) if !r.is_empty() => git_ok(&repo, &["fetch", "--prune", &r])?,
            _ => git_ok(&repo, &["fetch", "--all", "--prune"])?,
        };
        Ok(out)
    })
    .await
}

// ---- remote branches -----------------------------------------------------

#[derive(Serialize, Clone)]
pub struct GitRemoteBranch {
    /// Branch name WITHOUT the remote prefix (`main` not `origin/main`).
    pub name: String,
    /// Full ref form (`origin/main`) — what `git checkout --track` expects.
    pub full_ref: String,
    /// True if this is the symbolic HEAD pointer for the remote (e.g.
    /// `origin/HEAD -> origin/main`). UI shows it differently and skips
    /// it from most ops.
    pub is_head_pointer: bool,
    /// Local branch currently tracking this remote ref, if any.
    pub tracked_by: Option<String>,
    /// Tip subject line for the branch (best-effort).
    pub subject: Option<String>,
}

/// List branches under `refs/remotes/<remote>/`. We use `for-each-ref` so
/// we can extract the upstream-of mapping + the tip subject in a single
/// command instead of fanning out N `log -1` calls.
#[tauri::command]
pub async fn git_remote_branches(
    repo: String,
    remote: String,
) -> Result<Vec<GitRemoteBranch>, String> {
    let prefix = format!("refs/remotes/{remote}/");
    let format = "%(refname:short)%09%(symref)%09%(subject)";
    let out = git_ok(
        &repo,
        &[
            "for-each-ref",
            "--sort=refname",
            &format!("--format={format}"),
            &prefix,
        ],
    )?;

    // Build the local-branch → upstream map once so we can annotate each
    // remote branch with its tracking local. The cheap form:
    // `git for-each-ref refs/heads --format='%(refname:short)\t%(upstream:short)'`.
    let mut upstreams: std::collections::HashMap<String, String> = Default::default();
    if let Ok(locals) = git_ok(
        &repo,
        &[
            "for-each-ref",
            "--format=%(refname:short)\t%(upstream:short)",
            "refs/heads/",
        ],
    ) {
        for line in locals.lines() {
            let mut p = line.splitn(2, '\t');
            let local = p.next().unwrap_or("").to_string();
            let upstream = p.next().unwrap_or("").trim().to_string();
            if !upstream.is_empty() {
                upstreams.insert(upstream, local);
            }
        }
    }

    let mut list = Vec::new();
    for line in out.lines() {
        let mut p = line.splitn(3, '\t');
        let full_ref = p.next().unwrap_or("").to_string();
        let symref = p.next().unwrap_or("").trim().to_string();
        let subject = p.next().unwrap_or("").to_string();
        if full_ref.is_empty() {
            continue;
        }
        let name = full_ref
            .strip_prefix(&format!("{remote}/"))
            .unwrap_or(&full_ref)
            .to_string();
        let is_head_pointer = !symref.is_empty() || name == "HEAD";
        list.push(GitRemoteBranch {
            name,
            full_ref: full_ref.clone(),
            is_head_pointer,
            tracked_by: upstreams.get(&full_ref).cloned(),
            subject: if subject.is_empty() {
                None
            } else {
                Some(subject)
            },
        });
    }
    Ok(list)
}

/// Check out a remote branch into a new local tracking branch. If
/// `local_name` is omitted, uses the remote branch's leaf name (so
/// `origin/feat/foo` → local `feat/foo`).
#[tauri::command]
pub async fn git_checkout_remote_branch(
    repo: String,
    remote: String,
    branch: String,
    local_name: Option<String>,
) -> Result<(), String> {
    let full_ref = format!("{remote}/{branch}");
    let local = local_name.unwrap_or_else(|| branch.clone());
    // If the local already exists, just `checkout <local>`; otherwise
    // create-and-track.
    let exists = git_ok(
        &repo,
        &[
            "show-ref",
            "--verify",
            "--quiet",
            &format!("refs/heads/{local}"),
        ],
    )
    .is_ok();
    if exists {
        git_ok(&repo, &["checkout", &local])?;
    } else {
        git_ok(&repo, &["checkout", "-b", &local, "--track", &full_ref])?;
    }
    Ok(())
}

/// Delete a remote branch by pushing the empty ref. Strict form
/// `git push <remote> --delete <branch>` — the one lazygit invokes.
#[tauri::command]
pub async fn git_delete_remote_branch(
    repo: String,
    remote: String,
    branch: String,
) -> Result<(), String> {
    git_ok(&repo, &["push", &remote, "--delete", &branch])?;
    Ok(())
}

/// Point a local branch's upstream at the given remote ref. Pass `null` /
/// empty `upstream` to clear the upstream entirely (matches lazygit's
/// "unset upstream" flow).
#[tauri::command]
pub async fn git_set_upstream(
    repo: String,
    branch: String,
    upstream: Option<String>,
) -> Result<(), String> {
    match upstream {
        Some(u) if !u.is_empty() => {
            git_ok(
                &repo,
                &["branch", &format!("--set-upstream-to={u}"), &branch],
            )?;
        }
        _ => {
            git_ok(&repo, &["branch", "--unset-upstream", &branch])?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, path::Path};
    use tempfile::tempdir;

    fn repo_arg(repo: &Path) -> String {
        repo.to_string_lossy().into_owned()
    }

    fn git(repo: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(args)
            .output()
            .expect("run git");
        assert!(
            out.status.success(),
            "git {:?}\nstdout:\n{}\nstderr:\n{}",
            args,
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    fn init_repo() -> tempfile::TempDir {
        let td = tempdir().expect("tempdir");
        git(td.path(), &["init"]);
        git(td.path(), &["config", "user.email", "sikemux@example.test"]);
        git(td.path(), &["config", "user.name", "sikemux"]);
        td
    }

    fn commit_base(repo: &Path) {
        fs::write(repo.join("f.txt"), "base\n").expect("write base");
        git(repo, &["add", "f.txt"]);
        git(repo, &["commit", "-m", "base"]);
    }

    #[tokio::test]
    async fn discard_unstaged_preserves_staged_changes() {
        let td = init_repo();
        commit_base(td.path());

        fs::write(td.path().join("f.txt"), "staged\n").expect("write staged");
        git(td.path(), &["add", "f.txt"]);
        fs::write(td.path().join("f.txt"), "unstaged\n").expect("write unstaged");

        git_discard_file(repo_arg(td.path()), "f.txt".into(), "unstaged".into())
            .await
            .expect("discard unstaged");

        assert_eq!(
            fs::read_to_string(td.path().join("f.txt")).expect("read worktree"),
            "staged\n"
        );
        assert_eq!(git(td.path(), &["show", ":f.txt"]), "staged\n");
    }

    #[tokio::test]
    async fn blame_maps_committed_and_uncommitted_lines() {
        let td = init_repo();
        fs::write(td.path().join("f.txt"), "one\ntwo\nthree\n").expect("write");
        git(td.path(), &["add", "f.txt"]);
        git(td.path(), &["commit", "-m", "seed"]);

        // Disk blame: every line attributed to the single seed commit.
        let on_disk = git_blame(repo_arg(td.path()), "f.txt".into(), None)
            .await
            .expect("blame disk");
        assert_eq!(on_disk.lines.len(), 3);
        assert!(on_disk.lines.iter().all(|&i| i == on_disk.lines[0]));
        let c = &on_disk.commits[on_disk.lines[0] as usize];
        assert_eq!(c.author, "sikemux");
        assert!(!c.uncommitted);
        assert_eq!(c.summary, "seed");
        assert_eq!(c.short.len(), 8);

        // Buffer blame: an appended line shows as not-yet-committed.
        let buffer = "one\ntwo\nthree\nfour\n".to_string();
        let blame = git_blame(repo_arg(td.path()), "f.txt".into(), Some(buffer))
            .await
            .expect("blame buffer");
        assert_eq!(blame.lines.len(), 4);
        let last = &blame.commits[blame.lines[3] as usize];
        assert!(last.uncommitted, "appended line should be uncommitted");
        assert_eq!(last.summary, "Uncommitted changes");
        assert!(!blame.commits[blame.lines[0] as usize].uncommitted);
    }

    #[tokio::test]
    async fn blame_untracked_file_is_empty() {
        let td = init_repo();
        commit_base(td.path());
        fs::write(td.path().join("new.txt"), "hi\n").expect("write");
        let blame = git_blame(repo_arg(td.path()), "new.txt".into(), None)
            .await
            .expect("blame untracked");
        assert!(blame.commits.is_empty());
        assert!(blame.lines.is_empty());
    }

    #[tokio::test]
    async fn discard_all_removes_staged_new_file() {
        let td = init_repo();
        commit_base(td.path());

        fs::write(td.path().join("new.txt"), "new\n").expect("write new");
        git(td.path(), &["add", "new.txt"]);

        git_discard_file(repo_arg(td.path()), "new.txt".into(), "all".into())
            .await
            .expect("discard all");

        assert!(!td.path().join("new.txt").exists());
        assert_eq!(git(td.path(), &["status", "--porcelain"]), "");
    }
}

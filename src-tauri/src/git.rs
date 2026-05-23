use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::collections::HashMap;

use git2::{
    BranchType, DiffFormat, DiffLineType, DiffOptions, ErrorCode, Repository, Status, StatusOptions,
};
use serde::Serialize;

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
    hash: String,
    author: String,
    date: String,
    subject: String,
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
    if s.contains(Status::INDEX_NEW) { x = 'A'; }
    else if s.contains(Status::INDEX_MODIFIED) { x = 'M'; }
    else if s.contains(Status::INDEX_DELETED) { x = 'D'; }
    else if s.contains(Status::INDEX_RENAMED) { x = 'R'; }
    else if s.contains(Status::INDEX_TYPECHANGE) { x = 'T'; }

    if s.contains(Status::WT_NEW) { y = '?'; if x == ' ' { x = '?'; } }
    else if s.contains(Status::WT_MODIFIED) { y = 'M'; }
    else if s.contains(Status::WT_DELETED) { y = 'D'; }
    else if s.contains(Status::WT_RENAMED) { y = 'R'; }
    else if s.contains(Status::WT_TYPECHANGE) { y = 'T'; }
    else if s.contains(Status::CONFLICTED) { x = 'U'; y = 'U'; }

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
                if let (Some(local_oid), Some(up_oid)) =
                    (head.target(), up.get().target())
                {
                    if let Ok((ahead, behind)) = repo.graph_ahead_behind(local_oid, up_oid) {
                        status.ahead = ahead as i32;
                        status.behind = behind as i32;
                    }
                }
            }
        }
    } else if let Ok(rname) = repo.head_detached() {
        if rname { status.branch = "HEAD".to_string(); }
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
        if x == ' ' && y == ' ' { continue; }
        status.files.push(GitFile {
            path,
            index: x.to_string(),
            worktree: y.to_string(),
        });
    }
    Ok(status)
}

#[tauri::command]
pub fn git_status(repo: String) -> Result<GitStatus, String> {
    read_status(&open_repo(&repo)?)
}

// ---- branches & log -------------------------------------------------------

fn read_branches(repo: &Repository) -> Result<Vec<GitBranch>, String> {
    let mut out = Vec::new();
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
        let current = branch.is_head();
        out.push(GitBranch { name, current, upstream });
    }
    Ok(out)
}

#[tauri::command]
pub fn git_branches(repo: String) -> Result<Vec<GitBranch>, String> {
    read_branches(&open_repo(&repo)?)
}

fn relative_time(secs: i64) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let d = (now - secs).max(0);
    if d < 60 { return format!("{}s ago", d); }
    if d < 3600 { return format!("{}m ago", d / 60); }
    if d < 86400 { return format!("{}h ago", d / 3600); }
    if d < 86400 * 30 { return format!("{}d ago", d / 86400); }
    if d < 86400 * 365 { return format!("{}mo ago", d / (86400 * 30)); }
    format!("{}y ago", d / (86400 * 365))
}

fn read_log(repo: &Repository, limit: usize) -> Result<Vec<GitCommit>, String> {
    let mut revwalk = repo.revwalk().map_err(|e| e.message().to_string())?;
    if revwalk.push_head().is_err() {
        return Ok(Vec::new());
    }
    revwalk
        .set_sorting(git2::Sort::NONE)
        .map_err(|e| e.message().to_string())?;
    let mut out = Vec::with_capacity(limit);
    for (i, oid) in revwalk.enumerate() {
        if i >= limit { break; }
        let oid = match oid { Ok(o) => o, Err(_) => continue };
        let commit = match repo.find_commit(oid) { Ok(c) => c, Err(_) => continue };
        let short = commit
            .as_object()
            .short_id()
            .ok()
            .and_then(|b| b.as_str().map(String::from))
            .unwrap_or_else(|| oid.to_string()[..7].to_string());
        out.push(GitCommit {
            hash: short,
            author: commit.author().name().unwrap_or("").to_string(),
            date: relative_time(commit.time().seconds()),
            subject: commit.summary().unwrap_or("").to_string(),
        });
    }
    Ok(out)
}

#[tauri::command]
pub fn git_log(repo: String) -> Result<Vec<GitCommit>, String> {
    read_log(&open_repo(&repo)?, 60)
}

#[tauri::command]
pub fn git_overview(repo: String) -> Result<GitOverview, String> {
    let r = open_repo(&repo)?;
    Ok(GitOverview {
        status: read_status(&r)?,
        branches: read_branches(&r)?,
        log: read_log(&r, 60)?,
    })
}

#[tauri::command]
pub async fn git_checkout(repo: String, branch: String) -> Result<(), String> {
    // git2 checkout is fiddly with working-tree handling — shell out.
    git_ok(&repo, &["checkout", &branch]).map(|_| ())
}

// ---- diff -----------------------------------------------------------------

fn write_diff_to_string(diff: &git2::Diff) -> Result<String, String> {
    let mut out = String::new();
    diff.print(DiffFormat::Patch, |_d, _h, line| {
        match line.origin_value() {
            DiffLineType::Context => out.push(' '),
            DiffLineType::Addition => out.push('+'),
            DiffLineType::Deletion => out.push('-'),
            DiffLineType::FileHeader
            | DiffLineType::HunkHeader
            | DiffLineType::Binary => {}
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
        let head_tree = r
            .head()
            .ok()
            .and_then(|h| h.peel_to_tree().ok());
        let diff = r
            .diff_tree_to_index(head_tree.as_ref(), None, Some(&mut opts))
            .map_err(|e| e.message().to_string())?;
        return write_diff_to_string(&diff);
    }

    let diff = r
        .diff_index_to_workdir(None, Some(&mut opts))
        .map_err(|e| e.message().to_string())?;
    let s = write_diff_to_string(&diff)?;
    if !s.trim().is_empty() { return Ok(s); }

    // Untracked — fall back to git no-index for parity with the old impl.
    let (_, so, _) = run_git(
        &repo,
        &["diff", "--no-ext-diff", "--no-index", "--", "/dev/null", &path],
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

// ---- show / file_at -------------------------------------------------------

fn revparse_commit<'a>(
    repo: &'a Repository,
    rev: &str,
) -> Result<git2::Commit<'a>, String> {
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
fn file_at_cache(
) -> &'static Mutex<HashMap<(String, String, String), String>> {
    static C: std::sync::OnceLock<Mutex<HashMap<(String, String, String), String>>> =
        std::sync::OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

fn is_immutable_rev(rev: &str) -> bool {
    let head = rev
        .split(|c| c == '~' || c == '^')
        .next()
        .unwrap_or(rev);
    head.len() >= 7 && head.chars().all(|c| c.is_ascii_hexdigit())
}

#[tauri::command]
pub fn git_file_at(repo: String, rev: String, path: String) -> Result<String, String> {
    let cacheable = is_immutable_rev(&rev);
    let key = (repo.clone(), rev.clone(), path.clone());
    if cacheable {
        if let Some(hit) = file_at_cache().lock().ok().and_then(|c| c.get(&key).cloned()) {
            return Ok(hit);
        }
    }
    let r = open_repo(&repo)?;
    let content = match revparse_commit(&r, &rev) {
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
    };
    if cacheable {
        if let Ok(mut cache) = file_at_cache().lock() {
            if cache.len() > 500 { cache.clear(); }
            cache.insert(key, content.clone());
        }
    }
    Ok(content)
}

#[tauri::command]
pub async fn git_commit_files(repo: String, rev: String) -> Result<Vec<String>, String> {
    let r = open_repo(&repo)?;
    let commit = revparse_commit(&r, &rev)?;
    let new_tree = commit.tree().map_err(|e| e.message().to_string())?;
    let parent_tree = commit
        .parent(0)
        .ok()
        .and_then(|p| p.tree().ok());
    let diff = r
        .diff_tree_to_tree(parent_tree.as_ref(), Some(&new_tree), None)
        .map_err(|e| e.message().to_string())?;
    let mut paths = Vec::new();
    diff.foreach(
        &mut |d, _| {
            if let Some(p) = d.new_file().path().or_else(|| d.old_file().path()) {
                let s = p.to_string_lossy().into_owned();
                if !paths.contains(&s) { paths.push(s); }
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
    commit_with_message(&repo, &message)
}

#[tauri::command]
pub async fn git_push(repo: String) -> Result<String, String> {
    let (ok, so, se) = run_git(&repo, &["push"])?;
    if ok {
        return Ok(format!("{so}{se}").trim().to_string());
    }
    if se.contains("has no upstream branch") || se.contains("--set-upstream") {
        let branch = git_ok(&repo, &["branch", "--show-current"])?.trim().to_string();
        let (ok2, so2, se2) =
            run_git(&repo, &["push", "--set-upstream", "origin", &branch])?;
        return if ok2 {
            Ok(format!("{so2}{se2}").trim().to_string())
        } else {
            Err(se2)
        };
    }
    Err(se)
}

#[tauri::command]
pub async fn git_pull(repo: String) -> Result<String, String> {
    let (ok, so, se) = run_git(&repo, &["pull", "--ff-only"])?;
    if ok {
        Ok(format!("{so}{se}").trim().to_string())
    } else {
        Err(se)
    }
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
        "feat", "fix", "refactor", "chore", "docs", "test", "perf", "build", "ci",
        "style", "revert",
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

fn run_hermes(prompt: &str) -> Result<String, String> {
    let args = ["chat", "-Q", "-m", "openai/gpt-5.5", "-t", "safe", "-q", prompt];
    for bin in ["hermes", "/opt/homebrew/bin/hermes"] {
        match Command::new(bin).args(args).output() {
            Ok(out) if out.status.success() => {
                return Ok(String::from_utf8_lossy(&out.stdout).into_owned());
            }
            Ok(out) => {
                return Err(format!(
                    "hermes failed: {}",
                    String::from_utf8_lossy(&out.stderr)
                ));
            }
            Err(_) => continue,
        }
    }
    Err("hermes not found on PATH".into())
}

#[tauri::command]
pub async fn git_ai_commit(repo: String) -> Result<String, String> {
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
    let branch = git_ok(&repo, &["branch", "--show-current"])
        .unwrap_or_default()
        .trim()
        .to_string();
    let stat = git_ok(&repo, &["diff", "--cached", "--stat"]).unwrap_or_default();
    let mut diff =
        git_ok(&repo, &["diff", "--cached", "--no-ext-diff", "--unified=3"]).unwrap_or_default();
    let truncated = diff.len() > DIFF_LIMIT;
    if truncated {
        diff.truncate(DIFF_LIMIT);
        diff.push_str("\n\n[diff truncated — exceeds size limit]\n");
    }
    let repo_name = std::path::Path::new(&repo)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();

    let prompt = format!(
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
    );

    let message = clean_commit_message(&run_hermes(&prompt)?)?;
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

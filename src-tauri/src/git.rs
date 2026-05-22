use std::io::Write;
use std::process::{Command, Stdio};

use serde::Serialize;

// ---- helpers --------------------------------------------------------------

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

// Runs git, returning stdout on success or stderr (falling back to stdout) on failure.
fn git_ok(repo: &str, args: &[&str]) -> Result<String, String> {
    let (ok, so, se) = run_git(repo, args)?;
    if ok {
        Ok(so)
    } else {
        Err(if se.trim().is_empty() { so } else { se })
    }
}

// ---- status ---------------------------------------------------------------

#[derive(Serialize)]
pub struct GitFile {
    path: String,
    index: String,    // staged status char (porcelain X)
    worktree: String, // working-tree status char (porcelain Y)
}

#[derive(Serialize)]
pub struct GitStatus {
    branch: String,
    upstream: Option<String>,
    ahead: i32,
    behind: i32,
    files: Vec<GitFile>,
}

fn parse_count(track: &str, key: &str) -> i32 {
    track
        .find(key)
        .and_then(|i| {
            track[i + key.len()..]
                .split(|c: char| !c.is_ascii_digit())
                .next()
        })
        .and_then(|s| s.parse().ok())
        .unwrap_or(0)
}

#[tauri::command]
pub fn git_status(repo: String) -> Result<GitStatus, String> {
    let out = git_ok(&repo, &["status", "--porcelain", "--branch"])?;
    let mut status = GitStatus {
        branch: String::new(),
        upstream: None,
        ahead: 0,
        behind: 0,
        files: Vec::new(),
    };
    for line in out.lines() {
        if let Some(rest) = line.strip_prefix("## ") {
            if let Some(b) = rest.strip_prefix("No commits yet on ") {
                status.branch = b.trim().to_string();
                continue;
            }
            let (names, track) = rest.split_once(' ').unwrap_or((rest, ""));
            if let Some((b, up)) = names.split_once("...") {
                status.branch = b.to_string();
                status.upstream = Some(up.to_string());
            } else {
                status.branch = names.to_string();
            }
            status.ahead = parse_count(track, "ahead ");
            status.behind = parse_count(track, "behind ");
        } else if line.len() >= 4 {
            status.files.push(GitFile {
                index: line[0..1].to_string(),
                worktree: line[1..2].to_string(),
                path: line[3..].to_string(),
            });
        }
    }
    Ok(status)
}

// ---- diff -----------------------------------------------------------------

#[tauri::command]
pub fn git_diff(repo: String, path: String, staged: bool) -> Result<String, String> {
    if staged {
        return git_ok(&repo, &["diff", "--cached", "--no-ext-diff", "--", &path]);
    }
    let tracked = git_ok(&repo, &["diff", "--no-ext-diff", "--", &path])?;
    if !tracked.trim().is_empty() {
        return Ok(tracked);
    }
    // Untracked file — diff against an empty tree (exits non-zero by design).
    let (_, so, _) = run_git(
        &repo,
        &["diff", "--no-ext-diff", "--no-index", "--", "/dev/null", &path],
    )?;
    Ok(so)
}

// ---- staging --------------------------------------------------------------

#[tauri::command]
pub fn git_stage(repo: String, path: String) -> Result<(), String> {
    git_ok(&repo, &["add", "--", &path]).map(|_| ())
}

#[tauri::command]
pub fn git_unstage(repo: String, path: String) -> Result<(), String> {
    git_ok(&repo, &["restore", "--staged", "--", &path]).map(|_| ())
}

#[tauri::command]
pub fn git_stage_all(repo: String) -> Result<(), String> {
    git_ok(&repo, &["add", "-A"]).map(|_| ())
}

// ---- branches & log -------------------------------------------------------

#[derive(Serialize)]
pub struct GitBranch {
    name: String,
    current: bool,
    upstream: Option<String>,
}

#[tauri::command]
pub fn git_branches(repo: String) -> Result<Vec<GitBranch>, String> {
    let out = git_ok(
        &repo,
        &["branch", "--format=%(HEAD)%09%(refname:short)%09%(upstream:short)"],
    )?;
    Ok(out
        .lines()
        .filter_map(|line| {
            let p: Vec<&str> = line.split('\t').collect();
            if p.len() < 2 {
                return None;
            }
            Some(GitBranch {
                current: p[0] == "*",
                name: p[1].to_string(),
                upstream: p.get(2).filter(|s| !s.is_empty()).map(|s| s.to_string()),
            })
        })
        .collect())
}

#[tauri::command]
pub fn git_checkout(repo: String, branch: String) -> Result<(), String> {
    git_ok(&repo, &["checkout", &branch]).map(|_| ())
}

#[derive(Serialize)]
pub struct GitCommit {
    hash: String,
    author: String,
    date: String,
    subject: String,
}

#[tauri::command]
pub fn git_log(repo: String) -> Result<Vec<GitCommit>, String> {
    let out = git_ok(
        &repo,
        &["log", "-60", "--pretty=format:%h%x09%an%x09%ar%x09%s"],
    )?;
    Ok(out
        .lines()
        .filter_map(|l| {
            let p: Vec<&str> = l.splitn(4, '\t').collect();
            if p.len() < 4 {
                return None;
            }
            Some(GitCommit {
                hash: p[0].to_string(),
                author: p[1].to_string(),
                date: p[2].to_string(),
                subject: p[3].to_string(),
            })
        })
        .collect())
}

// Commit (or branch/ref) detail: message, file stat, and full patch.
#[tauri::command]
pub fn git_show(repo: String, rev: String) -> Result<String, String> {
    git_ok(&repo, &["show", "--no-ext-diff", "--stat", "-p", &rev])
}

// File content at a revision (e.g. HEAD). Empty string if the file did not
// exist there — so a new file shows as all-additions in the merge view.
#[tauri::command]
pub fn git_file_at(repo: String, rev: String, path: String) -> Result<String, String> {
    let (ok, so, _) = run_git(&repo, &["show", &format!("{rev}:{path}")])?;
    Ok(if ok { so } else { String::new() })
}

// Paths changed by a commit (or branch tip).
#[tauri::command]
pub fn git_commit_files(repo: String, rev: String) -> Result<Vec<String>, String> {
    let out = git_ok(&repo, &["show", "--name-only", "--pretty=format:", &rev])?;
    Ok(out
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(String::from)
        .collect())
}

// ---- commit / push / pull -------------------------------------------------

#[tauri::command]
pub fn git_commit(repo: String, message: String) -> Result<String, String> {
    let mut child = Command::new("git")
        .arg("-C")
        .arg(&repo)
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
pub fn git_push(repo: String) -> Result<String, String> {
    let (ok, so, se) = run_git(&repo, &["push"])?;
    if ok {
        return Ok(format!("{so}{se}").trim().to_string());
    }
    // No upstream yet — set it and retry.
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
pub fn git_pull(repo: String) -> Result<String, String> {
    let (ok, so, se) = run_git(&repo, &["pull", "--ff-only"])?;
    if ok {
        Ok(format!("{so}{se}").trim().to_string())
    } else {
        Err(se)
    }
}

// ---- AI commit (native port of ~/.config/shell/bin/hermes-commit) ---------

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
            Err(_) => continue, // binary not at this path — try the next
        }
    }
    Err("hermes not found on PATH".into())
}

/// Generate a conventional-commit message with Hermes from the staged diff
/// and commit it. Native port of the user's `hermes-commit` script.
#[tauri::command]
pub fn git_ai_commit(repo: String) -> Result<String, String> {
    if git_ok(&repo, &["diff", "--cached", "--name-only"])?
        .trim()
        .is_empty()
    {
        return Err("No staged changes — stage files first.".into());
    }
    let branch = git_ok(&repo, &["branch", "--show-current"])
        .unwrap_or_default()
        .trim()
        .to_string();
    let stat = git_ok(&repo, &["diff", "--cached", "--stat"]).unwrap_or_default();
    let mut diff =
        git_ok(&repo, &["diff", "--cached", "--no-ext-diff", "--unified=3"]).unwrap_or_default();
    diff.truncate(50_000);
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
    git_commit(repo.clone(), message.clone())?;
    Ok(message)
}

// ---- open PR (native port of ~/.config/shell/bin/pr-open) -----------------

#[tauri::command]
pub fn pr_open(repo: String) -> Result<String, String> {
    let remote = git_ok(&repo, &["remote", "get-url", "origin"])?
        .trim()
        .to_string();
    let branch = git_ok(&repo, &["branch", "--show-current"])?
        .trim()
        .to_string();
    if branch.is_empty() {
        return Err("no current branch (detached HEAD?)".into());
    }

    // SSH -> HTTPS.
    let mut url = if let Some(rest) = remote.strip_prefix("git@") {
        match rest.split_once(':') {
            Some((host, path)) => format!("https://{host}/{}", path.trim_end_matches(".git")),
            None => remote.clone(),
        }
    } else {
        remote.trim_end_matches(".git").to_string()
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

//! The git work Auto does in a card's worktree. Each of these blocks.

use std::path::{Path, PathBuf};
use std::process::Output;
use std::time::Duration;

const QUICK: Duration = Duration::from_secs(60);
/// Pushing and fetching wait on the network, and a commit on its hooks.
const SLOW: Duration = Duration::from_secs(5 * 60);
const CHECK: Duration = Duration::from_secs(30 * 60);
const OUTPUT_LIMIT: usize = 4 * 1024 * 1024;
/// How much of a failure's output a note or a fix request carries.
const TAIL_CHARS: usize = 3000;
const SLUG_MAX: usize = 40;
const BRANCH_PREFIX: &str = "sikemux/";

fn run(dir: &Path, program: &str, args: &[&str], timeout: Duration) -> Result<Output, String> {
    let mut command = sikemux_process::user_environment::command(program);
    command
        .args(args)
        .current_dir(dir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_EDITOR", "true");
    sikemux_process::run(&mut command, None, timeout, OUTPUT_LIMIT, None)
        .map_err(|error| format!("{program} did not run: {error}"))
}

fn git_in(dir: &Path, args: &[&str], timeout: Duration) -> Result<String, String> {
    let output = run(dir, "git", args, timeout)?;
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned());
    }
    let said = said(&output);
    Err(format!(
        "git {} failed{}",
        args.first().copied().unwrap_or_default(),
        if said.is_empty() {
            String::new()
        } else {
            format!(": {said}")
        }
    ))
}

fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    git_in(dir, args, QUICK)
}

/// The end of what a command wrote, which is where its error usually is.
pub(super) fn tail(text: &str) -> String {
    let text = text.trim();
    let count = text.chars().count();
    if count <= TAIL_CHARS {
        return text.to_owned();
    }
    let kept: String = text.chars().skip(count - TAIL_CHARS).collect();
    format!("…{kept}")
}

fn said(output: &Output) -> String {
    let mut text = String::from_utf8_lossy(&output.stderr).into_owned();
    let out = String::from_utf8_lossy(&output.stdout);
    if !out.trim().is_empty() {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(&out);
    }
    tail(&text)
}

/// A card's own checkout.
pub(super) struct Tree {
    pub repo: PathBuf,
    pub path: PathBuf,
    /// Where the agent works: the project's folder inside the worktree.
    pub cwd: PathBuf,
    pub branch: String,
    pub base: String,
    pub start_sha: String,
}

/// A few words of `text`, kebab-cased, to name a branch and folder after.
pub(super) fn slug(text: &str) -> String {
    let mut slug = String::new();
    for word in text
        .to_lowercase()
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|word| !word.is_empty())
    {
        let next = if slug.is_empty() {
            word.to_owned()
        } else {
            format!("{slug}-{word}")
        };
        if next.len() > SLUG_MAX {
            break;
        }
        slug = next;
    }
    if slug.is_empty() {
        "card".to_owned()
    } else {
        slug
    }
}

fn branch_exists(repo: &Path, branch: &str) -> bool {
    git(
        repo,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch}"),
        ],
    )
    .is_ok()
}

/// The branch to cut from and land on: the one the project's checkout is on,
/// else the remote's default.
fn base_branch(repo: &Path) -> Result<String, String> {
    if let Ok(branch) = git(repo, &["symbolic-ref", "--quiet", "--short", "HEAD"]) {
        return Ok(branch);
    }
    git(
        repo,
        &[
            "symbolic-ref",
            "--quiet",
            "--short",
            "refs/remotes/origin/HEAD",
        ],
    )
    .map(|remote| remote.trim_start_matches("origin/").to_owned())
    .map_err(|_| {
        "the project's checkout is on no branch, so Auto cannot tell which branch to work from"
            .to_owned()
    })
}

/// Cuts a worktree for a card beside the project's checkout, on a branch of
/// its own from the latest of the base branch.
pub(super) fn add_worktree(project: &Path, slug: &str) -> Result<Tree, String> {
    let repo = PathBuf::from(
        git(
            project,
            &["rev-parse", "--path-format=absolute", "--show-toplevel"],
        )
        .map_err(|_| {
            "the project is not a git repository, so Auto cannot give a card a worktree of its own"
                .to_owned()
        })?,
    );
    let inside = project
        .canonicalize()
        .ok()
        .zip(repo.canonicalize().ok())
        .and_then(|(project, repo)| project.strip_prefix(&repo).ok().map(Path::to_path_buf))
        .unwrap_or_default();
    let base = base_branch(&repo)?;
    let _ = git_in(&repo, &["fetch", "--quiet", "origin", &base], SLOW);
    let remote = format!("origin/{base}");
    let start = if git(&repo, &["rev-parse", "--verify", "--quiet", &remote]).is_ok() {
        remote
    } else {
        base.clone()
    };
    let start_sha = git(&repo, &["rev-parse", &start])?;
    let name = repo
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "project".to_owned());
    let folder = repo.with_file_name(format!("{name}.worktrees"));
    let (branch, path) = (1..=50)
        .map(|index| {
            let slug = if index == 1 {
                slug.to_owned()
            } else {
                format!("{slug}-{index}")
            };
            (format!("{BRANCH_PREFIX}{slug}"), folder.join(&slug))
        })
        .find(|(branch, path)| !path.exists() && !branch_exists(&repo, branch))
        .ok_or("every worktree name for this card is taken")?;
    std::fs::create_dir_all(&folder)
        .map_err(|error| format!("could not make {}: {error}", folder.display()))?;
    let target = path.to_string_lossy().into_owned();
    git_in(
        &repo,
        &[
            "worktree",
            "add",
            "--no-track",
            "-b",
            &branch,
            &target,
            &start_sha,
        ],
        SLOW,
    )?;
    Ok(Tree {
        cwd: path.join(&inside),
        repo,
        path,
        branch,
        base,
        start_sha,
    })
}

/// Commits whatever is left uncommitted in the worktree. False when there
/// was nothing to commit.
pub(super) fn commit_all(tree: &Path, message: &str) -> Result<bool, String> {
    if git(tree, &["status", "--porcelain"])?.is_empty() {
        return Ok(false);
    }
    git(tree, &["add", "--all"])?;
    git_in(tree, &["commit", "--quiet", "-m", message], SLOW)?;
    Ok(true)
}

/// How many commits the worktree's branch has on top of where it started.
pub(super) fn ahead(tree: &Path, start_sha: &str) -> Result<usize, String> {
    git(
        tree,
        &["rev-list", "--count", &format!("{start_sha}..HEAD")],
    )
    .map(|count| count.parse().unwrap_or(0))
}

pub(super) fn head(tree: &Path) -> Result<String, String> {
    git(tree, &["rev-parse", "HEAD"])
}

pub(super) fn origin(repo: &Path) -> Option<String> {
    git(repo, &["remote", "get-url", "origin"])
        .ok()
        .filter(|url| !url.is_empty())
}

/// Pushes the worktree's branch. `pushed` is the commit Auto last put there,
/// which a rebase may replace, but nothing someone else pushed since.
pub(super) fn push(tree: &Path, branch: &str, pushed: Option<&str>) -> Result<(), String> {
    let refspec = format!("HEAD:refs/heads/{branch}");
    let lease = pushed.map(|sha| format!("--force-with-lease=refs/heads/{branch}:{sha}"));
    let mut args = vec!["push", "--quiet"];
    if let Some(lease) = &lease {
        args.push(lease);
    }
    args.extend(["origin", &refspec]);
    git_in(tree, &args, SLOW).map(drop)
}

/// Puts the branch on top of the latest base. False when that conflicts,
/// which leaves the branch as it was.
pub(super) fn rebase(tree: &Path, base: &str) -> Result<bool, String> {
    git_in(tree, &["fetch", "--quiet", "origin", base], SLOW)?;
    if git_in(tree, &["rebase", &format!("origin/{base}")], SLOW).is_ok() {
        return Ok(true);
    }
    let _ = git(tree, &["rebase", "--abort"]);
    Ok(false)
}

/// Runs the project's check command in the worktree. Whether it passed, and
/// the end of what it wrote.
pub(super) fn check(cwd: &Path, command: &str) -> Result<(bool, String), String> {
    let output = run(cwd, "/bin/sh", &["-c", command], CHECK)?;
    Ok((output.status.success(), said(&output)))
}

/// Takes away a card's worktree and its branch, here and, when `remote`, on
/// the remote too.
pub(super) fn remove_worktree(repo: &Path, tree: &Path, branch: &str, remote: bool) {
    let target = tree.to_string_lossy().into_owned();
    if let Err(error) = git(repo, &["worktree", "remove", "--force", &target]) {
        eprintln!("sikemux core: Auto left the worktree {target}: {error}");
    }
    let _ = git(repo, &["branch", "-D", branch]);
    if !remote {
        return;
    }
    let _ = git_in(
        repo,
        &["push", "--quiet", "origin", "--delete", branch],
        SLOW,
    );
}

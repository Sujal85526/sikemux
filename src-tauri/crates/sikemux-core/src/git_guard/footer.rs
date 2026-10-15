//! How an agent's own `git commit` gets the footer naming the agents whose
//! lines it holds. The shim runs the commit with hooks of ours in front of the
//! repository's: they run its hooks as before, then ask the core for the
//! footer once git has settled what the commit holds, and add it to the
//! message. What the commit holds is git's business alone.
//!
//! The footer goes in at `prepare-commit-msg`, which runs even with
//! `--no-verify`, and again at `commit-msg` when the message had nothing to
//! put it under before the editor ran.

use std::ffi::OsString;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use serde_json::json;
use sha2::{Digest, Sha256};

use crate::trailers;

/// The name this binary is linked under for the hooks to run it.
pub(super) const LINK: &str = "sikemux-commit-footer";
/// The folder of the hooks, which the core hands agents.
pub(super) const HOOKS: &str = "SIKEMUX_AGENT_HOOKS";
/// Where the repository's own hooks are, for ours to run them.
const REPO_HOOKS: &str = "SIKEMUX_REPO_HOOKS";
const AMEND: &str = "SIKEMUX_COMMIT_AMEND";
const OURS: [&str; 2] = ["prepare-commit-msg", "commit-msg"];
const ANSWER_WAIT: Duration = Duration::from_secs(15);

pub(super) fn folder(data_dir: &Path) -> PathBuf {
    data_dir.join("agent-hooks")
}

/// Has `command`, the real git about to run `git <options> commit <args>`,
/// run our hooks in front of the repository's.
pub(super) fn prepare(command: &mut Command, git: &Path, options: &[String], args: &[String]) {
    let Some(folder) = std::env::var_os(HOOKS).map(PathBuf::from) else {
        return;
    };
    let Some(theirs) = repo_hooks(git, options) else {
        return;
    };
    let Ok(ours) = hooks_for(&folder, &theirs) else {
        return;
    };
    let amend = args
        .iter()
        .take_while(|arg| *arg != "--")
        .any(|arg| arg == "--amend");
    let mut setting = OsString::from("core.hooksPath=");
    setting.push(ours);
    command.arg("-c").arg(setting).env(REPO_HOOKS, theirs);
    if amend {
        command.env(AMEND, "1");
    } else {
        command.env_remove(AMEND);
    }
}

fn repo_hooks(git: &Path, options: &[String]) -> Option<PathBuf> {
    let output = sikemux_process::user_environment::command(git)
        .args(options)
        .args(["rev-parse", "--path-format=absolute", "--git-path", "hooks"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    let path = String::from_utf8(output.stdout).ok()?;
    (output.status.success() && !path.trim().is_empty()).then(|| PathBuf::from(path.trim()))
}

/// A folder of hooks that stand in for each of the repository's in `theirs`,
/// plus ours. Git runs every hook a folder has, so each set of hooks gets a
/// folder of its own, named for the set and for what the hooks say.
fn hooks_for(folder: &Path, theirs: &Path) -> std::io::Result<PathBuf> {
    let mut names: Vec<String> = std::fs::read_dir(theirs)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter(|entry| {
            std::fs::metadata(entry.path())
                .is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
        })
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| !name.contains('.'))
        .chain(OURS.map(str::to_owned))
        .collect();
    names.sort();
    names.dedup();
    let script = stand_in(&folder.join(LINK));
    let set = Sha256::new()
        .chain_update(names.join("\n"))
        .chain_update(&script)
        .finalize();
    let set = hex::encode(&set[..6]);
    let hooks = folder.join(set);
    if hooks.is_dir() {
        return Ok(hooks);
    }
    let fresh = folder.join(format!(".{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&fresh)?;
    for name in &names {
        let path = fresh.join(name);
        std::fs::write(&path, &script)?;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))?;
    }
    if std::fs::rename(&fresh, &hooks).is_err() {
        let _ = std::fs::remove_dir_all(&fresh);
    }
    Ok(hooks)
}

fn stand_in(footer: &Path) -> String {
    let footer = footer.to_string_lossy().replace('\'', "'\\''");
    format!(
        r#"#!/bin/sh
name=${{0##*/}}
hook="$SIKEMUX_REPO_HOOKS/$name"
case $name in
prepare-commit-msg|commit-msg)
	if [ -f "$hook" ] && [ -x "$hook" ]; then "$hook" "$@" || exit; fi
	if [ "$name" = commit-msg ] && grep -q '^Agent-Signature: ' "$1"; then exit 0; fi
	exec '{footer}' "$name" "$@" ;;
esac
[ -x "$hook" ] || exit 0
exec "$hook" "$@"
"#
    )
}

/// Run by our `prepare-commit-msg` and `commit-msg` with the hook's name and
/// the message file: puts the footer in the message. A commit goes on without
/// one when the core cannot be asked or the committer is no agent of its.
pub(super) fn run(args: Vec<OsString>) -> i32 {
    let [hook, file, ..] = args.as_slice() else {
        return 0;
    };
    let Ok(text) = std::fs::read_to_string(file) else {
        return 0;
    };
    let empty = trailers::into_message_file(&text, &[]).is_none();
    if empty || (hook == "commit-msg" && trailers::is_signed(&text)) {
        return 0;
    }
    let Some(footer) = ask() else {
        return 0;
    };
    if let Some(signed) = trailers::into_message_file(&text, &footer) {
        let _ = std::fs::write(file, signed);
    }
    0
}

fn ask() -> Option<Vec<String>> {
    let endpoint = std::env::var_os("SIKEMUX_CLI_ENDPOINT")
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .or_else(crate::cli::endpoint::default_endpoint_path)?;
    let top = std::env::current_dir().ok()?;
    let index = std::env::var_os("GIT_INDEX_FILE").map(|index| top.join(index));
    let params = json!({
        "index": index,
        "amend": std::env::var_os(AMEND).is_some(),
    });
    let answer = crate::cli::client::attempt(
        &endpoint,
        &top.to_string_lossy(),
        None,
        crate::cli::protocol::COMMIT_FOOTER_METHOD,
        &params,
        ANSWER_WAIT,
    )
    .ok()?;
    serde_json::from_value::<Vec<String>>(answer)
        .ok()
        .filter(|footer| !footer.is_empty())
}

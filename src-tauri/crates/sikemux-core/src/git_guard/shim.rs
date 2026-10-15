//! The `git` agents Sikemux starts find first on their PATH: this binary,
//! linked under that name. It refuses what [`super`] refuses and runs the real
//! git for everything else, whichever harness or shell the agent runs it from.
//!
//! Grok and Hermes rebuild PATH from the person's login profile, which puts
//! the system's git first, so they also check each shell command before it
//! runs: this binary again, linked as the hook their harnesses call.

use std::ffi::OsString;
use std::io::Read;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde_json::{json, Value};

/// The git the shim runs, as the core found it on the person's PATH.
const REAL_GIT: &str = "SIKEMUX_REAL_GIT";

/// The name the hook is linked under, outside the agents' PATH.
const HOOK: &str = "sikemux-git-hook";

static FOLDER: OnceLock<PathBuf> = OnceLock::new();
static GROK_PLUGIN: OnceLock<PathBuf> = OnceLock::new();
static HOOK_DATA_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Links this binary as `git` in a folder of `data_dir`, for agents started
/// from now on to find first, and as the hook, with the plugin Grok chats
/// load it from.
pub(crate) fn install(data_dir: &Path) {
    let folder = data_dir.join("agent-bin");
    if folder.to_string_lossy().contains(':') {
        return;
    }
    match link(&folder, "git") {
        Ok(()) => {
            let _ = FOLDER.set(folder);
        }
        Err(error) => eprintln!("sikemux core: agents' git commands go unchecked: {error}"),
    }
    match install_hook(data_dir) {
        Ok(plugin) => {
            let _ = GROK_PLUGIN.set(plugin);
            let _ = HOOK_DATA_DIR.set(data_dir.to_path_buf());
        }
        Err(error) => eprintln!("sikemux core: Grok's and Hermes's git go unchecked: {error}"),
    }
}

fn link(folder: &Path, name: &str) -> std::io::Result<()> {
    let binary = std::env::current_exe()?;
    std::fs::create_dir_all(folder)?;
    let path = folder.join(name);
    if std::fs::read_link(&path).is_ok_and(|target| target == binary) {
        return Ok(());
    }
    let fresh = folder.join(format!("{name}.{}", std::process::id()));
    let _ = std::fs::remove_file(&fresh);
    std::os::unix::fs::symlink(&binary, &fresh)?;
    std::fs::rename(&fresh, &path)
}

fn hook_folder(data_dir: &Path) -> PathBuf {
    data_dir.join("agent-hook")
}

fn install_hook(data_dir: &Path) -> std::io::Result<PathBuf> {
    let folder = hook_folder(data_dir);
    link(&folder, HOOK)?;
    let plugin = folder.join("sikemux");
    let hooks = json!({ "hooks": grok_hooks(&quoted(&folder.join(HOOK))) });
    sikemux_process::files::write_atomic(
        &plugin.join("hooks").join("hooks.json"),
        hooks.to_string().as_bytes(),
        false,
    )?;
    Ok(plugin)
}

/// The data folder the hook was linked in, and the command a harness runs it
/// with. None before [`install`].
pub(super) fn hook() -> Option<(&'static Path, String)> {
    let data_dir = HOOK_DATA_DIR.get()?;
    Some((data_dir, quoted(&hook_folder(data_dir).join(HOOK))))
}

/// Grok's `hooks` table with the hook on every shell command.
pub(super) fn grok_hooks(command: &str) -> Value {
    json!({
        "PreToolUse": [{
            "matcher": "Bash",
            "hooks": [{ "type": "command", "command": command }],
        }],
    })
}

/// The plugin a Grok chat loads the hook from. None before [`install`].
pub(crate) fn grok_plugin() -> Option<&'static Path> {
    GROK_PLUGIN.get().map(PathBuf::as_path)
}

/// `path` as one word for `sh -c`, and for Hermes, which splits a hook's
/// command the way a shell would.
fn quoted(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"))
}

/// The variables an agent runs with to find the shim first: `path`, or the
/// person's PATH, with the shim's folder ahead of it, and the real git. None
/// before [`install`].
pub(crate) fn environment(path: Option<&str>) -> Vec<(String, String)> {
    let Some(folder) = FOLDER.get() else {
        return Vec::new();
    };
    let folder = folder.to_string_lossy();
    let path = path
        .map(str::to_owned)
        .or_else(|| sikemux_process::user_environment::var("PATH"));
    let path = match path.filter(|path| !path.is_empty()) {
        Some(path) => format!("{folder}:{path}"),
        None => folder.into_owned(),
    };
    let mut env = vec![("PATH".to_owned(), path)];
    if let Some(git) = sikemux_process::user_environment::git_program() {
        env.push((REAL_GIT.to_owned(), git.to_string_lossy().into_owned()));
    }
    env
}

/// The shim's folder, for a shell to put first on PATH again after its
/// profile has run.
pub(crate) fn folder() -> Option<&'static Path> {
    FOLDER.get().map(PathBuf::as_path)
}

/// What `provider` is started with for its commands to find the shim. Codex
/// runs them in a login shell, whose profile puts the system's git ahead of
/// it, unless told not to.
pub(crate) fn arguments(provider: &str) -> &'static [&'static str] {
    match provider {
        "codex" if FOLDER.get().is_some() => &["-c", "allow_login_shell=false"],
        _ => &[],
    }
}

/// Runs as `git` or as the hook when this binary was started under either
/// name, and answers with its exit code. None under any other name.
pub fn run_if_git() -> Option<i32> {
    let mut args = std::env::args_os();
    let name = args.next()?;
    match Path::new(&name).file_name()?.to_str()? {
        "git" => Some(run(args.collect())),
        HOOK => Some(run_hook()),
        _ => None,
    }
}

/// Checks the shell command in the tool call a harness writes to stdin, in
/// Claude's hook form, which Grok and Hermes share. Exit code 2 refuses it,
/// with the reason on stderr.
fn run_hook() -> i32 {
    let mut input = String::new();
    if std::io::stdin().read_to_string(&mut input).is_err() {
        return 0;
    }
    let Ok(event) = serde_json::from_str::<Value>(&input) else {
        return 0;
    };
    let tool = &event["tool_input"];
    let (Some(command), Some(cwd)) = (tool["command"].as_str(), event["cwd"].as_str()) else {
        return 0;
    };
    let cwd = ["workdir", "cwd"]
        .iter()
        .find_map(|key| tool[*key].as_str())
        .map_or_else(|| PathBuf::from(cwd), |dir| Path::new(cwd).join(dir));
    match super::refusal(command, &cwd) {
        Some(refusal) => {
            eprintln!("{refusal}");
            2
        }
        None => 0,
    }
}

fn run(args: Vec<OsString>) -> i32 {
    let Some(git) = real_git() else {
        eprintln!("git: Sikemux found no git to run on PATH");
        return 127;
    };
    let words: Vec<String> = args
        .iter()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    let private_index = std::env::var_os("GIT_INDEX_FILE").is_some();
    if let Some(refusal) = super::refused(
        &words,
        private_index,
        sikemux_process::user_environment::command(&git),
    ) {
        eprintln!("{refusal}");
        return 1;
    }
    let error = sikemux_process::user_environment::command(&git)
        .args(&args)
        .exec();
    eprintln!("git: {}: {error}", git.display());
    126
}

/// The git this shim stands in for, never the shim itself.
fn real_git() -> Option<PathBuf> {
    let shim = std::env::current_exe()
        .and_then(|exe| exe.canonicalize())
        .ok();
    let not_shim = |git: &PathBuf| git.canonicalize().ok() != shim;
    std::env::var_os(REAL_GIT)
        .map(PathBuf::from)
        .filter(|git| git.is_file() && not_shim(git))
        .or_else(|| {
            sikemux_process::user_environment::find_executables("git")
                .into_iter()
                .find(|git| not_shim(git))
        })
}

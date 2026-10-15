//! The `git` agents Sikemux starts find first on their PATH: this binary,
//! linked under that name. It refuses what [`super`] refuses and runs the real
//! git for everything else, whichever harness or shell the agent runs it from.

use std::ffi::OsString;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// The git the shim runs, as the core found it on the person's PATH.
const REAL_GIT: &str = "SIKEMUX_REAL_GIT";

static FOLDER: OnceLock<PathBuf> = OnceLock::new();

/// Links this binary as `git` in a folder of `data_dir`, for agents started
/// from now on to find first.
pub(crate) fn install(data_dir: &Path) {
    let folder = data_dir.join("agent-bin");
    if folder.to_string_lossy().contains(':') {
        return;
    }
    match link(&folder) {
        Ok(()) => {
            let _ = FOLDER.set(folder);
        }
        Err(error) => eprintln!("sikemux core: agents' git commands go unchecked: {error}"),
    }
}

fn link(folder: &Path) -> std::io::Result<()> {
    let binary = std::env::current_exe()?;
    std::fs::create_dir_all(folder)?;
    let git = folder.join("git");
    if std::fs::read_link(&git).is_ok_and(|target| target == binary) {
        return Ok(());
    }
    let fresh = folder.join(format!("git.{}", std::process::id()));
    let _ = std::fs::remove_file(&fresh);
    std::os::unix::fs::symlink(&binary, &fresh)?;
    std::fs::rename(&fresh, &git)
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

/// Runs as `git` when this binary was started under that name, and answers
/// with its exit code. None when it was started under any other name.
pub fn run_if_git() -> Option<i32> {
    let mut args = std::env::args_os();
    let name = args.next()?;
    if Path::new(&name).file_name()? != "git" {
        return None;
    }
    Some(run(args.collect()))
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

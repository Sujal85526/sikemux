use std::collections::HashMap;
use std::ffi::OsStr;
use std::process::Command;
use std::sync::{Arc, OnceLock, RwLock};

/// Variables every child process gets on top of this process's own
/// environment. Launched from the Dock, the app has none of the user's shell
/// setup, so the app fills this in from their login shell instead of writing
/// into its own environment, which is unsafe once other threads are running.
#[derive(Default)]
pub struct UserEnvironment {
    pub variables: HashMap<String, String>,
}

struct Source {
    build: fn() -> UserEnvironment,
    /// Changes when what `build` reads from has changed, such as a login shell
    /// that answered after the first build gave up waiting for it.
    generation: fn() -> u64,
}

static SOURCE: OnceLock<Source> = OnceLock::new();
static ENVIRONMENT: RwLock<Option<(u64, Arc<UserEnvironment>)>> = RwLock::new(None);

/// Registers how to build the environment, and how to tell it has gone stale.
/// A process that never registers one gives its children exactly what it
/// inherited.
pub fn provide(build: fn() -> UserEnvironment, generation: fn() -> u64) {
    let _ = SOURCE.set(Source { build, generation });
}

/// Builds the environment now so the first spawn does not pay for it.
pub fn warm() {
    let _ = environment();
}

fn environment() -> Arc<UserEnvironment> {
    let Some(source) = SOURCE.get() else {
        return Arc::default();
    };
    let generation = (source.generation)();
    if let Ok(cached) = ENVIRONMENT.read() {
        if let Some((built, environment)) = cached.as_ref() {
            if *built == generation {
                return environment.clone();
            }
        }
    }
    let mut cached = ENVIRONMENT
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some((built, environment)) = cached.as_ref() {
        if *built == generation {
            return environment.clone();
        }
    }
    let environment = Arc::new((source.build)());
    *cached = Some((generation, environment.clone()));
    environment
}

/// A `Command` that runs with the user's environment, and finds `program` on
/// the user's `PATH`.
#[allow(clippy::disallowed_methods)]
pub fn command(program: impl AsRef<OsStr>) -> Command {
    let mut command = Command::new(program);
    command.envs(&environment().variables);
    command
}

/// Reads a variable the way a child process would see it.
pub fn var(name: &str) -> Option<String> {
    environment()
        .variables
        .get(name)
        .cloned()
        .or_else(|| std::env::var(name).ok())
}

/// Like `var`, but for values that may not be valid UTF-8, such as paths.
pub fn var_os(name: &str) -> Option<std::ffi::OsString> {
    environment()
        .variables
        .get(name)
        .map(Into::into)
        .or_else(|| std::env::var_os(name))
}

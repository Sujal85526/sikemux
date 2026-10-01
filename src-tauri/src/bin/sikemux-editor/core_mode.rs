use std::path::PathBuf;
use std::time::Duration;

use sikemux_core::protocol::BuildIdentity;
use sikemux_core::server::{self, ServerConfig, ServerError, DEFAULT_IDLE_EXIT};

struct CoreArgs {
    socket: Option<PathBuf>,
    idle_exit: Duration,
}

fn parse_args(mut args: impl Iterator<Item = String>) -> Result<CoreArgs, String> {
    let mut parsed = CoreArgs {
        socket: None,
        idle_exit: DEFAULT_IDLE_EXIT,
    };
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--socket" => {
                let path = args.next().ok_or("--socket needs a path")?;
                parsed.socket = Some(PathBuf::from(path));
            }
            "--idle-exit-secs" => {
                let seconds = args
                    .next()
                    .and_then(|value| value.parse::<u64>().ok())
                    .ok_or("--idle-exit-secs needs a whole number of seconds")?;
                parsed.idle_exit = Duration::from_secs(seconds);
            }
            other => return Err(format!("unknown argument {other:?}")),
        }
    }
    Ok(parsed)
}

/// `sikemux core [--socket <path>] [--idle-exit-secs N]`: runs the background
/// core in the foreground until it is shut down or sits idle.
pub fn run() -> i32 {
    let args = match parse_args(std::env::args().skip(2)) {
        Ok(args) => args,
        Err(message) => {
            eprintln!("sikemux core: {message}");
            eprintln!("usage: sikemux core [--socket <path>] [--idle-exit-secs N]");
            return 2;
        }
    };
    let Some(socket) = args.socket.or_else(sikemux_core::default_socket_path) else {
        eprintln!("sikemux core: HOME is not set, so pass --socket");
        return 2;
    };
    std::thread::spawn(sikemux_pty::user_shell::warm_login_shell_environment);
    match server::run(ServerConfig {
        socket,
        idle_exit: args.idle_exit,
        build: BuildIdentity {
            version: env!("CARGO_PKG_VERSION").into(),
            commit: env!("SIKEMUX_BUILD_COMMIT").into(),
            built_at: env!("SIKEMUX_BUILD_TIME").parse().unwrap_or(0),
        },
    }) {
        Ok(()) => 0,
        Err(error @ ServerError::AlreadyRunning { .. }) => {
            eprintln!("sikemux core: {error}");
            0
        }
        Err(error) => {
            eprintln!("sikemux core: {error}");
            1
        }
    }
}

use std::path::PathBuf;
use std::time::Duration;

use sikemux_core::protocol::BuildIdentity;
use sikemux_core::server::{self, ServerConfig, ServerError, DEFAULT_IDLE_EXIT};

struct CoreArgs {
    socket: Option<PathBuf>,
    idle_exit: Duration,
    cli_endpoint: Option<PathBuf>,
    data_dir: Option<PathBuf>,
}

fn parse_args(mut args: impl Iterator<Item = String>) -> Result<CoreArgs, String> {
    let mut parsed = CoreArgs {
        socket: None,
        idle_exit: DEFAULT_IDLE_EXIT,
        cli_endpoint: None,
        data_dir: None,
    };
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--socket" => {
                let path = args.next().ok_or("--socket needs a path")?;
                parsed.socket = Some(PathBuf::from(path));
            }
            "--cli-endpoint" => {
                let path = args.next().ok_or("--cli-endpoint needs a path")?;
                parsed.cli_endpoint = Some(PathBuf::from(path));
            }
            "--data-dir" => {
                let path = args.next().ok_or("--data-dir needs a path")?;
                parsed.data_dir = Some(PathBuf::from(path));
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

/// `sikemux core [--socket <path>] [--cli-endpoint <path>] [--data-dir <path>]
/// [--idle-exit-secs N]`: runs the background core in the foreground until it
/// is shut down or sits idle. It publishes agents' tool endpoint at
/// `--cli-endpoint`, by default where the CLI looks for it.
pub fn run() -> i32 {
    let args = match parse_args(std::env::args().skip(2)) {
        Ok(args) => args,
        Err(message) => {
            eprintln!("sikemux core: {message}");
            eprintln!("usage: sikemux core [--socket <path>] [--cli-endpoint <path>] [--data-dir <path>] [--idle-exit-secs N]");
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
        cli_endpoint: args
            .cli_endpoint
            .or_else(sikemux_core::cli::endpoint::default_endpoint_path),
        data_dir: args.data_dir,
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

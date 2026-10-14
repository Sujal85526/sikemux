//! `sikemux core sign-in`, `pair`, `sign-out`, `install`, `uninstall` and
//! `status`: what a host with no window needs to join an account, let devices
//! in and start its core at boot, from a terminal.

use std::collections::HashSet;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};

use sikemux_core::client::{ensure_running, probe, ClientEvent, CoreClient};
use sikemux_core::protocol::{AccountLinkState, DeviceAccess, Event, PendingDevice, RemoteStatus};
use tokio::sync::mpsc::UnboundedReceiver;

use crate::login_item::{self, CoreLaunch, IDENTIFIER};

const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

/// Runs `command`, or answers `None` when it is not one of these.
pub fn run(command: &str) -> Option<i32> {
    let work = match command {
        "sign-in" => Work::SignIn,
        "sign-out" => Work::SignOut,
        "pair" => Work::Pair,
        "install" => return Some(report(install())),
        "uninstall" => return Some(report(uninstall())),
        "status" => return Some(report(status())),
        _ => return None,
    };
    crate::install_tls_crypto();
    Some(report(running().and_then(|socket| {
        runtime()?.block_on(with_core(&socket, work))
    })))
}

enum Work {
    SignIn,
    SignOut,
    Pair,
}

fn report(result: Result<(), String>) -> i32 {
    match result {
        Ok(()) => 0,
        Err(message) => {
            eprintln!("sikemux core: {message}");
            1
        }
    }
}

fn launch() -> Result<CoreLaunch, String> {
    login_item::headless_launch().ok_or_else(|| "HOME is not set".into())
}

fn runtime() -> Result<tokio::runtime::Runtime, String> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| error.to_string())
}

/// The core's socket, starting the core first when none runs.
fn running() -> Result<PathBuf, String> {
    let launch = launch()?;
    if let Some(logs) = launch.log.parent() {
        std::fs::create_dir_all(logs).map_err(|error| error.to_string())?;
    }
    ensure_running(&launch.socket, &launch.binary, &launch.log, &launch.args)
        .map_err(|error| error.to_string())?;
    Ok(launch.socket)
}

async fn with_core(socket: &Path, work: Work) -> Result<(), String> {
    let (core, mut events) = CoreClient::connect(socket)
        .await
        .map_err(|error| error.to_string())?;
    match work {
        Work::SignIn => {
            let account = crate::account::sign_in_by_code(&core, |signing| {
                println!(
                    "To add this host to your Sikemux account, open\n\n  {}\n\nand check the code {}, or enter it in Sikemux on your phone.",
                    signing.verification_url, signing.user_code
                );
                println!("Waiting for approval…");
            })
            .await
            .map_err(|error| error.to_string())?;
            println!("Signed in to {account}.");
            pair(&core, &mut events).await
        }
        Work::SignOut => {
            core.set_owner(None)
                .await
                .map_err(|error| error.to_string())?;
            println!("Signed out. Paired devices stay paired.");
            Ok(())
        }
        Work::Pair => pair(&core, &mut events).await,
    }
}

/// Asks here about every device that wants to join, until the person stops it.
async fn pair(
    core: &CoreClient,
    events: &mut UnboundedReceiver<ClientEvent>,
) -> Result<(), String> {
    let mut status = core
        .remote_status()
        .await
        .map_err(|error| error.to_string())?;
    if status.owner.is_none() {
        return Err("this host is not signed in; run `sikemux core sign-in` first".into());
    }
    println!(
        "Join this host from Sikemux on your phone; each device asks here first. Press Ctrl-C to stop."
    );
    let mut asked = HashSet::new();
    loop {
        asked.retain(|id| status.pending.iter().any(|request| &request.id == id));
        let fresh: Vec<PendingDevice> = status
            .pending
            .iter()
            .filter(|request| !asked.contains(&request.id))
            .cloned()
            .collect();
        for request in fresh {
            asked.insert(request.id.clone());
            let access = ask(request.clone()).await?;
            if let Err(error) = core
                .answer_pairing(
                    request.id,
                    access.is_some(),
                    access.unwrap_or(DeviceAccess::Watch),
                )
                .await
            {
                println!("{} could not be answered: {error}", request.name);
            }
        }
        status = next_status(events).await?;
    }
}

async fn next_status(events: &mut UnboundedReceiver<ClientEvent>) -> Result<RemoteStatus, String> {
    loop {
        match events.recv().await {
            Some(ClientEvent::Event(Event::Remote { status })) => return Ok(status),
            Some(_) => {}
            None => return Err("the core went away".into()),
        }
    }
}

async fn ask(request: PendingDevice) -> Result<Option<DeviceAccess>, String> {
    tokio::task::spawn_blocking(move || {
        let mut stdout = std::io::stdout();
        let _ = write!(
            stdout,
            "{} ({}) asks to join. Allow [f]ull control, [w]atch only, or [N]o? ",
            request.name, request.platform
        );
        let _ = stdout.flush();
        let mut line = String::new();
        std::io::stdin()
            .lock()
            .read_line(&mut line)
            .map_err(|error| error.to_string())?;
        Ok(match line.trim().to_ascii_lowercase().as_str() {
            "f" | "full" => Some(DeviceAccess::Full),
            "w" | "watch" => Some(DeviceAccess::Watch),
            _ => None,
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

fn install() -> Result<(), String> {
    let launch = launch()?;
    let path = login_item::install(IDENTIFIER, &launch).map_err(|error| error.to_string())?;
    login_item::start(IDENTIFIER);
    println!("The core starts at login from {}.", path.display());
    Ok(())
}

fn uninstall() -> Result<(), String> {
    match login_item::remove(IDENTIFIER).map_err(|error| error.to_string())? {
        true => println!("The core no longer starts at login. Stop it with `sikemux core stop`."),
        false => println!("The core was not set to start at login."),
    }
    Ok(())
}

fn status() -> Result<(), String> {
    let launch = launch()?;
    let starts = login_item::path(IDENTIFIER).filter(|path| path.exists());
    println!(
        "Starts at login: {}",
        starts.map_or("no".into(), |path| path.display().to_string())
    );
    let Ok(hello) = probe(&launch.socket, PROBE_TIMEOUT) else {
        println!("Core: not running on {}", launch.socket.display());
        return Ok(());
    };
    println!(
        "Core: running, pid {}, version {}",
        hello.pid, hello.build.version
    );
    let remote = runtime()?.block_on(remote_status(&launch.socket))?;
    match &remote.owner {
        Some(owner) => println!("Account: {owner}"),
        None => println!("Account: not signed in"),
    }
    if let Some(link) = &remote.account {
        let state = match link.state {
            AccountLinkState::Connecting => "connecting",
            AccountLinkState::Live => "connected",
            AccountLinkState::Offline => "offline, trying again",
            AccountLinkState::Removed => "taken off the account",
        };
        println!("Account connection: {state}");
    }
    println!(
        "Remote access: {}, {} paired, {} waiting",
        if remote.enabled { "on" } else { "off" },
        remote.devices.len(),
        remote.pending.len()
    );
    Ok(())
}

async fn remote_status(socket: &Path) -> Result<RemoteStatus, String> {
    let (core, _events) = CoreClient::connect(socket)
        .await
        .map_err(|error| error.to_string())?;
    core.remote_status()
        .await
        .map_err(|error| error.to_string())
}

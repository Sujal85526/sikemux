//! Terminals live in the background core (`sikemux core`); these commands
//! forward to it over its socket. Output comes back on the connection and is
//! fanned out to the webview channels that show each terminal, with the same
//! ack-based flow control the in-process terminals had.

pub(crate) mod commands;
mod sink;
mod streams;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use sikemux_core::client::{ensure_running, ClientError, CoreClient};
use sikemux_core::protocol::{SessionId, SessionInfo, SessionKind};
use tauri::{AppHandle, Manager};

use crate::error::{AppError, AppResult};

use sink::AppSink;
use streams::StreamTable;

/// Browser tabs are child webviews of the same app. Every terminal event
/// belongs to the workbench, so address it by label instead of broadcasting.
const MAIN_WEBVIEW: &str = "main";
/// Long enough for the core's shared kill grace plus reaping a few hundred
/// sessions.
const STOP_TIMEOUT: Duration = Duration::from_secs(5);

struct CoreSettings {
    app: AppHandle,
    socket: PathBuf,
    binary: Option<PathBuf>,
    log: PathBuf,
    manifest_dir: Option<PathBuf>,
}

#[derive(Default)]
pub struct PtyManager {
    settings: OnceLock<CoreSettings>,
    client: Mutex<Option<Arc<CoreClient>>>,
    connecting: tokio::sync::Mutex<()>,
    streams: Arc<StreamTable>,
    /// Set once the app is leaving, so a core that goes away is not started
    /// again.
    closing: AtomicBool,
}

fn core_error(error: ClientError) -> AppError {
    match error {
        ClientError::Core(message) => {
            if let Some(reason) = message.strip_prefix("invalid argument: ") {
                AppError::BadArgText(reason.to_string())
            } else if let Some(reason) = message.strip_prefix("pty: ") {
                AppError::Pty(reason.to_string())
            } else {
                AppError::Other(message)
            }
        }
        other => AppError::Pty(other.to_string()),
    }
}

/// What a PTY was opened for, so a process found under it can be traced back
/// to a terminal pane, an agent or a task.
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PtyOwner {
    pub project: Option<String>,
    pub pane_id: Option<String>,
    pub agent_id: Option<String>,
    pub task_execution_id: Option<String>,
}

pub(crate) struct PtyProcess {
    pub pid: u32,
    pub pty_id: SessionId,
    pub owner: PtyOwner,
}

#[derive(serde::Serialize)]
pub struct PtyDiagnostics {
    pub core_pid: Option<u32>,
    pub ptys: usize,
    pub subscribers: usize,
    pub output_frames: u64,
    pub output_bytes: u64,
    pub working_agents: usize,
    pub blocked_agents: usize,
    pub idle_agents: usize,
    pub unknown_agents: usize,
}

impl PtyManager {
    /// Remembers where the core lives and starts connecting to it on a worker
    /// thread. Call once the process environment is final, because a core
    /// started from here inherits it.
    pub fn start(&self, app: &AppHandle) {
        let Some(socket) = sikemux_core::default_socket_path() else {
            eprintln!("Sikemux terminals are unavailable: HOME is not set");
            return;
        };
        let log = app
            .path()
            .app_log_dir()
            .unwrap_or_else(|_| std::env::temp_dir())
            .join("core.log");
        let manifest_dir = app
            .path()
            .app_config_dir()
            .ok()
            .map(|directory| directory.join("agent-detection"));
        let _ = self.settings.set(CoreSettings {
            app: app.clone(),
            socket,
            binary: crate::cli_server::cli_executable_path(),
            log,
            manifest_dir,
        });
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Some(manager) = app.try_state::<PtyManager>() {
                if let Err(error) = manager.client().await {
                    eprintln!("Sikemux could not reach its terminal core: {error}");
                }
            }
        });
    }

    fn current(&self) -> Option<Arc<CoreClient>> {
        self.client
            .lock()
            .ok()?
            .clone()
            .filter(|client| client.is_connected())
    }

    /// The live connection to the core, starting the core first if needed.
    pub(crate) async fn client(&self) -> AppResult<Arc<CoreClient>> {
        if let Some(client) = self.current() {
            return Ok(client);
        }
        let _connecting = self.connecting.lock().await;
        if let Some(client) = self.current() {
            return Ok(client);
        }
        let settings = self
            .settings
            .get()
            .ok_or_else(|| AppError::Pty("the terminal core is not configured yet".into()))?;
        let binary = settings.binary.clone().ok_or_else(|| {
            AppError::Pty("the sikemux-editor sidecar that runs terminals is missing".into())
        })?;
        let socket = settings.socket.clone();
        let log = settings.log.clone();
        if let Some(directory) = log.parent() {
            let _ = std::fs::create_dir_all(directory);
        }
        tauri::async_runtime::spawn_blocking(move || ensure_running(&socket, &binary, &log))
            .await
            .map_err(|error| AppError::Pty(format!("core start join: {error}")))?
            .map_err(core_error)?;
        let sink = Arc::new(AppSink::new(settings.app.clone(), self.streams.clone()));
        let client = Arc::new(
            CoreClient::connect_with(&settings.socket, sink)
                .await
                .map_err(core_error)?,
        );
        client
            .configure(settings.manifest_dir.clone())
            .await
            .map_err(core_error)?;
        if let Ok(mut current) = self.client.lock() {
            *current = Some(client.clone());
        }
        Ok(client)
    }

    /// The core went away: every session the app knew is gone with it.
    fn disconnected(&self) {
        sink::report_all_exited(&self.streams);
        if self.closing.load(Ordering::Acquire) {
            return;
        }
        if let Some(settings) = self.settings.get() {
            let app = settings.app.clone();
            tauri::async_runtime::spawn(async move {
                if let Some(manager) = app.try_state::<PtyManager>() {
                    if let Err(error) = manager.client().await {
                        eprintln!("Sikemux could not restart its terminal core: {error}");
                    }
                }
            });
        }
    }

    fn block_on_core<F>(&self, work: impl FnOnce(Arc<CoreClient>) -> F)
    where
        F: std::future::Future<Output = Result<(), ClientError>>,
    {
        let Some(client) = self.current() else {
            return;
        };
        let work = work(client);
        let result = tauri::async_runtime::block_on(async move {
            tokio::time::timeout(STOP_TIMEOUT, work).await
        });
        match result {
            Ok(Ok(())) => {}
            Ok(Err(error)) => eprintln!("Sikemux terminal core: {error}"),
            Err(_) => eprintln!("Sikemux terminal core did not answer within {STOP_TIMEOUT:?}"),
        }
        drop(self.streams.take_all());
    }

    /// Stops every terminal and task and waits for them, so a reloaded page or
    /// a closed window leaves nothing running.
    pub fn stop_all(&self) {
        self.block_on_core(|client| async move { client.stop_all().await });
    }

    /// Stops everything and lets the core exit with the app.
    pub fn shutdown(&self) {
        self.closing.store(true, Ordering::Release);
        self.block_on_core(|client| async move { client.shutdown(true).await });
    }

    pub(crate) fn core_pid(&self) -> Option<u32> {
        self.current().map(|client| client.core_pid())
    }

    pub(crate) async fn sessions(&self) -> AppResult<Vec<SessionInfo>> {
        self.client().await?.list().await.map_err(core_error)
    }

    pub(crate) async fn live_processes(&self) -> AppResult<Vec<PtyProcess>> {
        Ok(self
            .sessions()
            .await?
            .into_iter()
            .filter(|session| session.running)
            .filter_map(|session| {
                Some(PtyProcess {
                    pid: session.pid?,
                    pty_id: session.id,
                    owner: PtyOwner {
                        project: session.project,
                        pane_id: session.pane_id,
                        agent_id: session.agent_id,
                        task_execution_id: session.task_execution_id,
                    },
                })
            })
            .collect())
    }

    pub async fn diagnostics(&self) -> PtyDiagnostics {
        let sessions = match self.current() {
            Some(client) => client.list().await.unwrap_or_default(),
            None => Vec::new(),
        };
        let agents = |state: &str| {
            sessions
                .iter()
                .filter(|session| {
                    session.kind == SessionKind::Terminal
                        && session.agent_state.as_deref() == Some(state)
                })
                .count()
        };
        let (output_frames, output_bytes) = sink::output_totals();
        PtyDiagnostics {
            core_pid: self.core_pid(),
            ptys: sessions.len(),
            subscribers: self.streams.subscriber_count(),
            output_frames,
            output_bytes,
            working_agents: agents("working"),
            blocked_agents: agents("blocked"),
            idle_agents: agents("idle"),
            unknown_agents: agents("unknown"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::core_error;
    use sikemux_core::client::ClientError;

    #[test]
    fn core_errors_keep_the_categories_and_messages_the_frontend_reads() {
        let missing = core_error(ClientError::Core("invalid argument: pty not found".into()));
        assert_eq!(missing.category(), "bad-arg");
        assert_eq!(missing.to_string(), "invalid argument: pty not found");

        let capacity = core_error(ClientError::Core("pty: PTY capacity reached".into()));
        assert_eq!(capacity.category(), "pty");
        assert_eq!(capacity.to_string(), "pty: PTY capacity reached");

        let gone = core_error(ClientError::Disconnected);
        assert_eq!(gone.category(), "pty");
    }
}

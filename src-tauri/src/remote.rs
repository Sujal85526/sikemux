//! Remote access and pairing for the Devices settings page, and the projects
//! and agents the app offers paired devices. The core keeps the state; these
//! commands forward to it.

use std::sync::{Arc, Mutex};

use serde::Deserialize;
use sikemux_core::client::CoreClient;
use sikemux_core::protocol::{ChatLauncher, DeviceAccess, ProjectInfo, RemoteStatus};
use tauri::{AppHandle, State};

use crate::acp::LauncherSpec;
use crate::error::AppResult;
use crate::pty::{core_error, PtyManager};

/// What the app last published, sent again to a core it reconnects to: the
/// core keeps it in memory only.
#[derive(Default)]
pub struct PublishedWorkspace(Mutex<Option<(Vec<ProjectInfo>, Vec<ChatLauncher>)>>);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LauncherRequest {
    id: String,
    provider: String,
    label: String,
    config_path: Option<String>,
    executable_path: Option<String>,
    #[serde(default)]
    environment_keys: Vec<String>,
    permission_mode: String,
}

#[tauri::command]
pub async fn remote_publish_workspace(
    app: AppHandle,
    manager: State<'_, PtyManager>,
    published: State<'_, PublishedWorkspace>,
    projects: Vec<ProjectInfo>,
    launchers: Vec<LauncherRequest>,
) -> AppResult<()> {
    let mut ready = Vec::with_capacity(launchers.len());
    for request in launchers {
        let spec = LauncherSpec {
            id: request.id,
            provider: request.provider,
            label: request.label,
            config_path: request.config_path,
            executable_path: request.executable_path,
            environment_keys: request.environment_keys,
            permission_mode: request.permission_mode,
        };
        if let Ok(launcher) = crate::acp::launcher(&app, spec).await {
            ready.push(launcher);
        }
    }
    if let Ok(mut last) = published.0.lock() {
        *last = Some((projects.clone(), ready.clone()));
    }
    let client = manager.client().await?;
    client
        .publish_workspace(projects, ready)
        .await
        .map_err(core_error)
}

/// Gives a core the app just connected to what it published to the last one.
pub(crate) async fn republish(published: &PublishedWorkspace, client: &Arc<CoreClient>) {
    let last = published.0.lock().ok().and_then(|last| last.clone());
    if let Some((projects, launchers)) = last {
        if let Err(error) = client.publish_workspace(projects, launchers).await {
            eprintln!("Sikemux could not tell its core which agents devices may start: {error}");
        }
    }
}

#[tauri::command]
pub async fn remote_status(manager: State<'_, PtyManager>) -> AppResult<RemoteStatus> {
    let client = manager.client().await?;
    client.remote_status().await.map_err(core_error)
}

#[tauri::command]
pub async fn remote_set_enabled(
    manager: State<'_, PtyManager>,
    enabled: bool,
) -> AppResult<RemoteStatus> {
    let client = manager.client().await?;
    client.set_remote_access(enabled).await.map_err(core_error)
}

#[tauri::command]
pub async fn remote_set_device_access(
    manager: State<'_, PtyManager>,
    id: String,
    access: DeviceAccess,
) -> AppResult<RemoteStatus> {
    let client = manager.client().await?;
    client
        .set_device_access(id, access)
        .await
        .map_err(core_error)
}

#[tauri::command]
pub async fn remote_revoke_device(
    manager: State<'_, PtyManager>,
    id: String,
) -> AppResult<RemoteStatus> {
    let client = manager.client().await?;
    client.revoke_device(id).await.map_err(core_error)
}

#[tauri::command]
pub async fn remote_open_pairing(manager: State<'_, PtyManager>) -> AppResult<RemoteStatus> {
    let client = manager.client().await?;
    client.open_pairing().await.map_err(core_error)
}

#[tauri::command]
pub async fn remote_close_pairing(manager: State<'_, PtyManager>) -> AppResult<RemoteStatus> {
    let client = manager.client().await?;
    client.close_pairing().await.map_err(core_error)
}

#[tauri::command]
pub async fn remote_answer_pairing(
    manager: State<'_, PtyManager>,
    id: String,
    allow: bool,
    access: DeviceAccess,
) -> AppResult<RemoteStatus> {
    let client = manager.client().await?;
    client
        .answer_pairing(id, allow, access)
        .await
        .map_err(core_error)
}

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures::{SinkExt, StreamExt};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio_tungstenite::tungstenite::Message;

use crate::error::{AppError, AppResult};

const VIEWPORT_WIDTH: u32 = 1280;
const VIEWPORT_HEIGHT: u32 = 800;

#[derive(Default)]
pub struct BrowserManager {
    runtime: Mutex<BrowserRuntime>,
    child: std::sync::Mutex<Option<Child>>,
}

pub struct BrowserMcpLaunch {
    pub command: String,
    pub args: Vec<String>,
}

#[derive(Default)]
struct BrowserRuntime {
    cdp: Option<Arc<CdpClient>>,
    cdp_http_url: Option<String>,
    state_dir: Option<PathBuf>,
    active_targets: HashMap<String, String>,
    target_sessions: HashMap<String, String>,
}

struct CdpClient {
    sender: mpsc::UnboundedSender<Message>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>,
    sequence: AtomicU64,
}

impl CdpClient {
    async fn connect(url: &str) -> AppResult<Arc<Self>> {
        let (socket, _) = tokio_tungstenite::connect_async(url)
            .await
            .map_err(|error| AppError::Other(format!("browser CDP connect failed: {error}")))?;
        let (mut writer, mut reader) = socket.split();
        let (sender, mut outbound) = mpsc::unbounded_channel::<Message>();
        let pending = Arc::new(Mutex::new(HashMap::<u64, oneshot::Sender<Value>>::new()));
        let pending_reader = pending.clone();

        tokio::spawn(async move {
            while let Some(message) = outbound.recv().await {
                if writer.send(message).await.is_err() {
                    break;
                }
            }
        });
        tokio::spawn(async move {
            while let Some(Ok(message)) = reader.next().await {
                let Message::Text(text) = message else {
                    continue;
                };
                let Ok(value) = serde_json::from_str::<Value>(&text) else {
                    continue;
                };
                let Some(id) = value.get("id").and_then(Value::as_u64) else {
                    continue;
                };
                if let Some(reply) = pending_reader.lock().await.remove(&id) {
                    let _ = reply.send(value);
                }
            }
            let mut pending = pending_reader.lock().await;
            pending.clear();
        });

        Ok(Arc::new(Self {
            sender,
            pending,
            sequence: AtomicU64::new(1),
        }))
    }

    async fn call(
        &self,
        method: &str,
        params: Value,
        session_id: Option<&str>,
    ) -> AppResult<Value> {
        let id = self.sequence.fetch_add(1, Ordering::Relaxed);
        let (reply, receive) = oneshot::channel();
        self.pending.lock().await.insert(id, reply);
        let mut message = json!({ "id": id, "method": method, "params": params });
        if let Some(session_id) = session_id {
            message["sessionId"] = Value::String(session_id.to_owned());
        }
        if self
            .sender
            .send(Message::Text(message.to_string().into()))
            .is_err()
        {
            self.pending.lock().await.remove(&id);
            return Err(AppError::Other("browser CDP connection closed".into()));
        }
        let response = tokio::time::timeout(Duration::from_secs(15), receive)
            .await
            .map_err(|_| AppError::Other(format!("browser CDP {method} timed out")))?
            .map_err(|_| AppError::Other("browser CDP response channel closed".into()))?;
        if let Some(error) = response.get("error") {
            return Err(AppError::Other(format!(
                "browser CDP {method} failed: {error}"
            )));
        }
        Ok(response.get("result").cloned().unwrap_or(Value::Null))
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTab {
    id: String,
    title: String,
    url: String,
    active: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSnapshot {
    tabs: Vec<BrowserTab>,
    active_tab_id: Option<String>,
    frame: Option<String>,
    cursor: Option<BrowserCursor>,
    viewport_width: u32,
    viewport_height: u32,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCursor {
    agent_id: String,
    target_id: String,
    x: f64,
    y: f64,
    pressed: bool,
    updated_at: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPointerInput {
    kind: String,
    x: f64,
    y: f64,
    #[serde(default)]
    button: Option<String>,
    #[serde(default)]
    delta_x: f64,
    #[serde(default)]
    delta_y: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserKeyInput {
    kind: String,
    key: String,
    code: String,
    #[serde(default)]
    text: String,
    #[serde(default)]
    modifiers: u8,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserViewport {
    width: u32,
    height: u32,
}

impl BrowserManager {
    fn is_started(&self) -> bool {
        self.runtime
            .try_lock()
            .ok()
            .is_some_and(|runtime| runtime.cdp.is_some())
    }

    pub fn drain(&self) {
        if let Ok(mut child) = self.child.lock() {
            if let Some(mut child) = child.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
        if let Ok(mut runtime) = self.runtime.try_lock() {
            runtime.cdp = None;
        }
    }

    pub async fn ensure_started(&self, app: &AppHandle) -> AppResult<()> {
        let mut runtime = self.runtime.lock().await;
        if let Some(cdp) = runtime.cdp.as_ref() {
            if cdp
                .call("Browser.getVersion", json!({}), None)
                .await
                .is_ok()
            {
                return Ok(());
            }
            runtime.cdp = None;
        }

        let state_dir = app
            .path()
            .app_data_dir()
            .map_err(|error| {
                AppError::Other(format!("browser data directory unavailable: {error}"))
            })?
            .join("browser");
        let profile_dir = state_dir.join("profile");
        std::fs::create_dir_all(&profile_dir)?;
        initialize_registry(&state_dir)?;
        let active_port = profile_dir.join("DevToolsActivePort");
        let _ = std::fs::remove_file(&active_port);

        if let Ok(mut current) = self.child.lock() {
            if let Some(mut child) = current.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
        let executable = browser_executable(app)?;
        let mut child = Command::new(&executable)
            .args([
                "--headless=new",
                "--remote-debugging-address=127.0.0.1",
                "--remote-debugging-port=0",
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-background-networking",
                "--disable-component-update",
                "--disable-default-apps",
                "--disable-sync",
                &format!("--window-size={VIEWPORT_WIDTH},{VIEWPORT_HEIGHT}"),
                &format!("--user-data-dir={}", profile_dir.display()),
                "about:blank",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| {
                AppError::Other(format!("could not start bundled browser: {error}"))
            })?;

        let (http_url, websocket_url) = match wait_for_debug_endpoint(&active_port).await {
            Ok(endpoint) => endpoint,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        };
        let cdp = match CdpClient::connect(&websocket_url).await {
            Ok(cdp) => cdp,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        };
        std::fs::write(
            state_dir.join("runtime.json"),
            serde_json::to_vec(
                &json!({ "cdpUrl": http_url, "webSocketDebuggerUrl": websocket_url }),
            )?,
        )?;
        *self
            .child
            .lock()
            .map_err(|_| AppError::Other("browser process lock poisoned".into()))? = Some(child);
        runtime.cdp = Some(cdp);
        runtime.cdp_http_url = Some(http_url);
        runtime.state_dir = Some(state_dir);
        runtime.active_targets.clear();
        runtime.target_sessions.clear();
        Ok(())
    }

    pub async fn environment(
        &self,
        app: &AppHandle,
        agent_id: &str,
    ) -> AppResult<Vec<(String, String)>> {
        validate_agent_id(agent_id)?;
        self.ensure_started(app).await?;
        let runtime = self.runtime.lock().await;
        let state_dir = runtime
            .state_dir
            .as_ref()
            .ok_or_else(|| AppError::Other("browser state directory unavailable".into()))?;
        Ok(vec![
            (
                "SIKEMUX_BROWSER_STATE_DIR".into(),
                state_dir.to_string_lossy().into_owned(),
            ),
            (
                "SIKEMUX_BROWSER_CDP_URL".into(),
                runtime.cdp_http_url.clone().unwrap_or_default(),
            ),
            ("SIKEMUX_BROWSER_AGENT_ID".into(), agent_id.to_owned()),
        ])
    }

    pub fn mcp_launch(&self, app: &AppHandle) -> AppResult<BrowserMcpLaunch> {
        if let Some(command) = std::env::var_os("SIKEMUX_BROWSER_MCP_EXECUTABLE") {
            return Ok(BrowserMcpLaunch {
                command: PathBuf::from(command).to_string_lossy().into_owned(),
                args: Vec::new(),
            });
        }
        let executable_name = if cfg!(windows) {
            "sikemux-browser-mcp.exe"
        } else {
            "sikemux-browser-mcp"
        };
        if let Ok(current) = std::env::current_exe() {
            if let Some(parent) = current.parent() {
                let bundled = parent.join(executable_name);
                if bundled.is_file() {
                    return Ok(BrowserMcpLaunch {
                        command: bundled.to_string_lossy().into_owned(),
                        args: Vec::new(),
                    });
                }
            }
        }
        if let Ok(resource_dir) = app.path().resource_dir() {
            let bundled = resource_dir.join(executable_name);
            if bundled.is_file() {
                return Ok(BrowserMcpLaunch {
                    command: bundled.to_string_lossy().into_owned(),
                    args: Vec::new(),
                });
            }
        }
        #[cfg(debug_assertions)]
        {
            let project = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .expect("Tauri manifest has a project parent")
                .join("browser");
            return Ok(BrowserMcpLaunch {
                command: "uv".into(),
                args: vec![
                    "run".into(),
                    "--project".into(),
                    project.to_string_lossy().into_owned(),
                    "python".into(),
                    project
                        .join("sikemux_browser_mcp.py")
                        .to_string_lossy()
                        .into_owned(),
                ],
            });
        }
        #[allow(unreachable_code)]
        Err(AppError::Other(
            "bundled browser MCP sidecar is missing".into(),
        ))
    }

    async fn cdp_and_state_dir(&self, app: &AppHandle) -> AppResult<(Arc<CdpClient>, PathBuf)> {
        self.ensure_started(app).await?;
        let runtime = self.runtime.lock().await;
        Ok((
            runtime
                .cdp
                .clone()
                .ok_or_else(|| AppError::Other("browser CDP unavailable".into()))?,
            runtime
                .state_dir
                .clone()
                .ok_or_else(|| AppError::Other("browser state directory unavailable".into()))?,
        ))
    }

    async fn target_session(
        &self,
        app: &AppHandle,
        target_id: &str,
    ) -> AppResult<(Arc<CdpClient>, String)> {
        let (cdp, _) = self.cdp_and_state_dir(app).await?;
        {
            let runtime = self.runtime.lock().await;
            if let Some(session_id) = runtime.target_sessions.get(target_id) {
                return Ok((cdp, session_id.clone()));
            }
        }
        let result = cdp
            .call(
                "Target.attachToTarget",
                json!({ "targetId": target_id, "flatten": true }),
                None,
            )
            .await?;
        let session_id = result
            .get("sessionId")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::Other("browser target attach returned no session".into()))?
            .to_owned();
        self.runtime
            .lock()
            .await
            .target_sessions
            .insert(target_id.to_owned(), session_id.clone());
        cdp.call("Page.enable", json!({}), Some(&session_id))
            .await?;
        Ok((cdp, session_id))
    }

    async fn owned_tabs(&self, app: &AppHandle, agent_id: &str) -> AppResult<Vec<BrowserTab>> {
        validate_agent_id(agent_id)?;
        let (cdp, state_dir) = self.cdp_and_state_dir(app).await?;
        let targets = cdp.call("Target.getTargets", json!({}), None).await?;
        let available = targets
            .get("targetInfos")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|target| {
                target
                    .get("targetId")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .collect::<std::collections::HashSet<_>>();
        prune_owned_targets(&state_dir, agent_id, &available)?;
        let owned = owned_target_ids(&state_dir, agent_id)?;
        let active_from_agent = std::fs::read(state_dir.join(format!("active-{agent_id}.json")))
            .ok()
            .and_then(|contents| serde_json::from_slice::<Value>(&contents).ok())
            .and_then(|value| {
                value
                    .get("targetId")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            });
        let active = active_from_agent.or_else(|| {
            self.runtime
                .try_lock()
                .ok()
                .and_then(|runtime| runtime.active_targets.get(agent_id).cloned())
        });
        let mut tabs = targets
            .get("targetInfos")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|target| target.get("type").and_then(Value::as_str) == Some("page"))
            .filter_map(|target| {
                let id = target.get("targetId")?.as_str()?.to_owned();
                owned.contains(&id).then(|| BrowserTab {
                    active: active.as_deref() == Some(id.as_str()),
                    id,
                    title: target
                        .get("title")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                    url: target
                        .get("url")
                        .and_then(Value::as_str)
                        .unwrap_or("about:blank")
                        .to_owned(),
                })
            })
            .collect::<Vec<_>>();
        if !tabs.is_empty() && !tabs.iter().any(|tab| tab.active) {
            tabs[0].active = true;
            self.runtime
                .lock()
                .await
                .active_targets
                .insert(agent_id.to_owned(), tabs[0].id.clone());
        }
        if let Some(active) = tabs.iter().find(|tab| tab.active).map(|tab| tab.id.clone()) {
            self.runtime
                .lock()
                .await
                .active_targets
                .insert(agent_id.to_owned(), active);
        }
        Ok(tabs)
    }

    async fn active_target(&self, app: &AppHandle, agent_id: &str) -> AppResult<Option<String>> {
        let tabs = self.owned_tabs(app, agent_id).await?;
        Ok(tabs.iter().find(|tab| tab.active).map(|tab| tab.id.clone()))
    }
}

fn initialize_registry(state_dir: &Path) -> AppResult<()> {
    std::fs::create_dir_all(state_dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(state_dir, std::fs::Permissions::from_mode(0o700))?;
    }
    let connection = Connection::open(state_dir.join("tabs.sqlite3"))
        .map_err(|error| AppError::State(error.to_string()))?;
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS browser_tabs (
                target_id TEXT PRIMARY KEY,
                agent_id TEXT NOT NULL,
                created_at INTEGER NOT NULL DEFAULT (unixepoch())
            );",
        )
        .map_err(|error| AppError::State(error.to_string()))?;
    Ok(())
}

fn validate_agent_id(agent_id: &str) -> AppResult<()> {
    if agent_id.is_empty()
        || agent_id.len() > 128
        || !agent_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':'))
    {
        return Err(AppError::BadArg("invalid browser agent id"));
    }
    Ok(())
}

fn validate_target_id(target_id: &str) -> AppResult<()> {
    if target_id.is_empty()
        || target_id.len() > 128
        || !target_id.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(AppError::BadArg("invalid browser target id"));
    }
    Ok(())
}

fn validate_url_input(url: &str) -> AppResult<()> {
    if url.len() > 16 * 1024
        || url.contains('\0')
        || url.chars().any(|character| character.is_control())
    {
        return Err(AppError::BadArg("invalid browser URL"));
    }
    Ok(())
}

fn owned_target_ids(
    state_dir: &Path,
    agent_id: &str,
) -> AppResult<std::collections::HashSet<String>> {
    let connection = Connection::open(state_dir.join("tabs.sqlite3"))
        .map_err(|error| AppError::State(error.to_string()))?;
    let mut statement = connection
        .prepare("SELECT target_id FROM browser_tabs WHERE agent_id = ?1 ORDER BY created_at")
        .map_err(|error| AppError::State(error.to_string()))?;
    let rows = statement
        .query_map([agent_id], |row| row.get::<_, String>(0))
        .map_err(|error| AppError::State(error.to_string()))?;
    rows.collect::<Result<_, _>>()
        .map_err(|error| AppError::State(error.to_string()))
}

fn prune_owned_targets(
    state_dir: &Path,
    agent_id: &str,
    available: &std::collections::HashSet<String>,
) -> AppResult<()> {
    let connection = Connection::open(state_dir.join("tabs.sqlite3"))
        .map_err(|error| AppError::State(error.to_string()))?;
    let owned = owned_target_ids(state_dir, agent_id)?;
    for target_id in owned.difference(available) {
        connection
            .execute(
                "DELETE FROM browser_tabs WHERE target_id = ?1 AND agent_id = ?2",
                params![target_id, agent_id],
            )
            .map_err(|error| AppError::State(error.to_string()))?;
    }
    Ok(())
}

fn register_target(state_dir: &Path, agent_id: &str, target_id: &str) -> AppResult<()> {
    let connection = Connection::open(state_dir.join("tabs.sqlite3"))
        .map_err(|error| AppError::State(error.to_string()))?;
    connection
        .execute(
            "INSERT OR REPLACE INTO browser_tabs (target_id, agent_id) VALUES (?1, ?2)",
            params![target_id, agent_id],
        )
        .map_err(|error| AppError::State(error.to_string()))?;
    Ok(())
}

fn unregister_target(state_dir: &Path, target_id: &str) -> AppResult<()> {
    let connection = Connection::open(state_dir.join("tabs.sqlite3"))
        .map_err(|error| AppError::State(error.to_string()))?;
    connection
        .execute("DELETE FROM browser_tabs WHERE target_id = ?1", [target_id])
        .map_err(|error| AppError::State(error.to_string()))?;
    Ok(())
}

fn write_active_target(state_dir: &Path, agent_id: &str, target_id: Option<&str>) -> AppResult<()> {
    let temporary = state_dir.join(format!("active-{agent_id}.tmp"));
    let destination = state_dir.join(format!("active-{agent_id}.json"));
    std::fs::write(
        &temporary,
        serde_json::to_vec(&json!({ "targetId": target_id }))?,
    )?;
    std::fs::rename(temporary, destination)?;
    Ok(())
}

async fn wait_for_debug_endpoint(path: &Path) -> AppResult<(String, String)> {
    for _ in 0..150 {
        if let Ok(contents) = tokio::fs::read_to_string(path).await {
            let mut lines = contents.lines();
            if let (Some(port), Some(websocket_path)) = (lines.next(), lines.next()) {
                let http = format!("http://127.0.0.1:{port}");
                return Ok((
                    http.clone(),
                    format!("ws://127.0.0.1:{port}{websocket_path}"),
                ));
            }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Err(AppError::Other(
        "bundled browser did not expose a CDP endpoint".into(),
    ))
}

fn browser_executable(app: &AppHandle) -> AppResult<PathBuf> {
    if let Some(path) = std::env::var_os("SIKEMUX_BROWSER_EXECUTABLE") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Ok(path);
        }
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        if let Some(path) = find_bundled_browser(&resource_dir.join("browser-runtime")) {
            return Ok(path);
        }
    }
    #[cfg(target_os = "macos")]
    for path in [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ] {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Ok(path);
        }
    }
    #[cfg(target_os = "windows")]
    for root in [
        std::env::var_os("PROGRAMFILES"),
        std::env::var_os("PROGRAMFILES(X86)"),
    ]
    .into_iter()
    .flatten()
    {
        let path = PathBuf::from(root).join("Google/Chrome/Application/chrome.exe");
        if path.is_file() {
            return Ok(path);
        }
    }
    #[cfg(target_os = "linux")]
    for path in [
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/usr/bin/google-chrome",
    ] {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Ok(path);
        }
    }
    Err(AppError::Other(
        "bundled Chromium runtime is missing".into(),
    ))
}

fn find_bundled_browser(root: &Path) -> Option<PathBuf> {
    if !root.is_dir() {
        return None;
    }
    let mut pending = vec![root.to_owned()];
    while let Some(directory) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                pending.push(path);
                continue;
            }
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or_default();
            if matches!(
                name,
                "Chromium"
                    | "chrome"
                    | "chrome.exe"
                    | "chrome-headless-shell"
                    | "headless_shell.exe"
                    | "Google Chrome for Testing"
            ) {
                return Some(path);
            }
        }
    }
    None
}

fn normalize_url(input: &str) -> String {
    let value = input.trim();
    if value.is_empty() {
        return "about:blank".into();
    }
    if value == "about:blank" || value.contains("://") {
        return value.to_owned();
    }
    if value.starts_with("localhost") || value.starts_with("127.0.0.1") || value.contains('.') {
        return format!(
            "http{}://{value}",
            if value.starts_with("localhost") || value.starts_with("127.0.0.1") {
                ""
            } else {
                "s"
            }
        );
    }
    let query = url::form_urlencoded::byte_serialize(value.as_bytes()).collect::<String>();
    format!("https://www.google.com/search?q={query}")
}

#[tauri::command]
pub async fn browser_snapshot(
    app: AppHandle,
    manager: State<'_, BrowserManager>,
    agent_id: String,
    include_frame: bool,
    viewport: Option<BrowserViewport>,
) -> AppResult<BrowserSnapshot> {
    if !include_frame && !manager.is_started() {
        return Ok(BrowserSnapshot {
            tabs: Vec::new(),
            active_tab_id: None,
            frame: None,
            cursor: None,
            viewport_width: VIEWPORT_WIDTH,
            viewport_height: VIEWPORT_HEIGHT,
        });
    }
    let mut tabs = manager.owned_tabs(&app, &agent_id).await?;
    let (_, state_dir) = manager.cdp_and_state_dir(&app).await?;
    let active = tabs.iter().find(|tab| tab.active).map(|tab| tab.id.clone());
    let viewport = viewport.unwrap_or(BrowserViewport {
        width: VIEWPORT_WIDTH,
        height: VIEWPORT_HEIGHT,
    });
    let frame = if include_frame {
        if let Some(target_id) = active.as_deref() {
            let (cdp, session_id) = manager.target_session(&app, target_id).await?;
            cdp.call(
                "Emulation.setDeviceMetricsOverride",
                json!({
                    "width": viewport.width.clamp(320, 3840),
                    "height": viewport.height.clamp(240, 2160),
                    "deviceScaleFactor": 1,
                    "mobile": false
                }),
                Some(&session_id),
            )
            .await?;
            let capture = cdp
                .call(
                    "Page.captureScreenshot",
                    json!({ "format": "jpeg", "quality": 82, "fromSurface": true }),
                    Some(&session_id),
                )
                .await?;
            capture
                .get("data")
                .and_then(Value::as_str)
                .map(str::to_owned)
        } else {
            None
        }
    } else {
        None
    };
    tabs.sort_by_key(|tab| !tab.active);
    let cursor = std::fs::read(state_dir.join(format!("cursor-{agent_id}.json")))
        .ok()
        .and_then(|contents| serde_json::from_slice::<BrowserCursor>(&contents).ok())
        .filter(|cursor| {
            cursor.agent_id == agent_id
                && active.as_deref() == Some(cursor.target_id.as_str())
                && current_unix_seconds() - cursor.updated_at < 2.0
        });
    Ok(BrowserSnapshot {
        tabs,
        active_tab_id: active,
        frame,
        cursor,
        viewport_width: viewport.width,
        viewport_height: viewport.height,
    })
}

fn current_unix_seconds() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0.0, |duration| duration.as_secs_f64())
}

#[tauri::command]
pub async fn browser_new_tab(
    app: AppHandle,
    manager: State<'_, BrowserManager>,
    agent_id: String,
    url: Option<String>,
) -> AppResult<String> {
    if let Some(url) = url.as_deref() {
        validate_url_input(url)?;
    }
    let (cdp, state_dir) = manager.cdp_and_state_dir(&app).await?;
    let result = cdp
        .call(
            "Target.createTarget",
            json!({ "url": normalize_url(url.as_deref().unwrap_or("about:blank")) }),
            None,
        )
        .await?;
    let target_id = result
        .get("targetId")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Other("browser did not create a target".into()))?
        .to_owned();
    register_target(&state_dir, &agent_id, &target_id)?;
    write_active_target(&state_dir, &agent_id, Some(&target_id))?;
    manager
        .runtime
        .lock()
        .await
        .active_targets
        .insert(agent_id, target_id.clone());
    Ok(target_id)
}

#[tauri::command]
pub async fn browser_switch_tab(
    app: AppHandle,
    manager: State<'_, BrowserManager>,
    agent_id: String,
    target_id: String,
) -> AppResult<()> {
    validate_target_id(&target_id)?;
    let tabs = manager.owned_tabs(&app, &agent_id).await?;
    if !tabs.iter().any(|tab| tab.id == target_id) {
        return Err(AppError::BadArg("browser tab does not belong to agent"));
    }
    let (cdp, state_dir) = manager.cdp_and_state_dir(&app).await?;
    cdp.call(
        "Target.activateTarget",
        json!({ "targetId": target_id }),
        None,
    )
    .await?;
    manager
        .runtime
        .lock()
        .await
        .active_targets
        .insert(agent_id.clone(), target_id.clone());
    write_active_target(&state_dir, &agent_id, Some(&target_id))?;
    Ok(())
}

#[tauri::command]
pub async fn browser_close_tab(
    app: AppHandle,
    manager: State<'_, BrowserManager>,
    agent_id: String,
    target_id: String,
) -> AppResult<()> {
    validate_target_id(&target_id)?;
    let tabs = manager.owned_tabs(&app, &agent_id).await?;
    if !tabs.iter().any(|tab| tab.id == target_id) {
        return Err(AppError::BadArg("browser tab does not belong to agent"));
    }
    let (cdp, state_dir) = manager.cdp_and_state_dir(&app).await?;
    cdp.call("Target.closeTarget", json!({ "targetId": target_id }), None)
        .await?;
    unregister_target(&state_dir, &target_id)?;
    let mut runtime = manager.runtime.lock().await;
    runtime.target_sessions.remove(&target_id);
    if runtime.active_targets.get(&agent_id) == Some(&target_id) {
        runtime.active_targets.remove(&agent_id);
    }
    drop(runtime);
    let next = manager
        .owned_tabs(&app, &agent_id)
        .await?
        .first()
        .map(|tab| tab.id.as_str().to_owned());
    write_active_target(&state_dir, &agent_id, next.as_deref())?;
    Ok(())
}

#[tauri::command]
pub async fn browser_navigate(
    app: AppHandle,
    manager: State<'_, BrowserManager>,
    agent_id: String,
    url: String,
) -> AppResult<()> {
    validate_url_input(&url)?;
    let Some(target_id) = manager.active_target(&app, &agent_id).await? else {
        browser_new_tab(app, manager, agent_id, Some(url)).await?;
        return Ok(());
    };
    let (cdp, session_id) = manager.target_session(&app, &target_id).await?;
    cdp.call(
        "Page.navigate",
        json!({ "url": normalize_url(&url) }),
        Some(&session_id),
    )
    .await?;
    Ok(())
}

async fn browser_history(
    app: &AppHandle,
    manager: &BrowserManager,
    agent_id: &str,
    delta: i64,
) -> AppResult<()> {
    let Some(target_id) = manager.active_target(app, agent_id).await? else {
        return Ok(());
    };
    let (cdp, session_id) = manager.target_session(app, &target_id).await?;
    let history = cdp
        .call("Page.getNavigationHistory", json!({}), Some(&session_id))
        .await?;
    let current = history
        .get("currentIndex")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let wanted = current + delta;
    if let Some(entry_id) = history
        .get("entries")
        .and_then(Value::as_array)
        .and_then(|entries| entries.get(wanted.max(0) as usize))
        .and_then(|entry| entry.get("id"))
        .and_then(Value::as_i64)
    {
        cdp.call(
            "Page.navigateToHistoryEntry",
            json!({ "entryId": entry_id }),
            Some(&session_id),
        )
        .await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn browser_back(
    app: AppHandle,
    manager: State<'_, BrowserManager>,
    agent_id: String,
) -> AppResult<()> {
    browser_history(&app, &manager, &agent_id, -1).await
}

#[tauri::command]
pub async fn browser_forward(
    app: AppHandle,
    manager: State<'_, BrowserManager>,
    agent_id: String,
) -> AppResult<()> {
    browser_history(&app, &manager, &agent_id, 1).await
}

#[tauri::command]
pub async fn browser_reload(
    app: AppHandle,
    manager: State<'_, BrowserManager>,
    agent_id: String,
) -> AppResult<()> {
    let Some(target_id) = manager.active_target(&app, &agent_id).await? else {
        return Ok(());
    };
    let (cdp, session_id) = manager.target_session(&app, &target_id).await?;
    cdp.call("Page.reload", json!({}), Some(&session_id))
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn browser_pointer(
    app: AppHandle,
    manager: State<'_, BrowserManager>,
    agent_id: String,
    input: BrowserPointerInput,
) -> AppResult<()> {
    if !matches!(input.kind.as_str(), "move" | "down" | "up" | "wheel")
        || !input.x.is_finite()
        || !input.y.is_finite()
        || !input.delta_x.is_finite()
        || !input.delta_y.is_finite()
        || input.x.abs() > 16_384.0
        || input.y.abs() > 16_384.0
        || input.delta_x.abs() > 16_384.0
        || input.delta_y.abs() > 16_384.0
        || input
            .button
            .as_deref()
            .is_some_and(|button| !matches!(button, "none" | "left" | "middle" | "right"))
    {
        return Err(AppError::BadArg("invalid browser pointer input"));
    }
    let Some(target_id) = manager.active_target(&app, &agent_id).await? else {
        return Ok(());
    };
    let (cdp, session_id) = manager.target_session(&app, &target_id).await?;
    let event_type = match input.kind.as_str() {
        "down" => "mousePressed",
        "up" => "mouseReleased",
        "wheel" => "mouseWheel",
        _ => "mouseMoved",
    };
    cdp.call(
        "Input.dispatchMouseEvent",
        json!({
            "type": event_type,
            "x": input.x,
            "y": input.y,
            "button": input.button.as_deref().unwrap_or("none"),
            "buttons": if input.kind == "down" { 1 } else { 0 },
            "clickCount": if matches!(input.kind.as_str(), "down" | "up") { 1 } else { 0 },
            "deltaX": input.delta_x,
            "deltaY": input.delta_y
        }),
        Some(&session_id),
    )
    .await?;
    Ok(())
}

#[tauri::command]
pub async fn browser_key(
    app: AppHandle,
    manager: State<'_, BrowserManager>,
    agent_id: String,
    input: BrowserKeyInput,
) -> AppResult<()> {
    if !matches!(input.kind.as_str(), "down" | "up" | "text")
        || input.key.len() > 128
        || input.code.len() > 128
        || input.text.len() > 16 * 1024
        || input.key.contains('\0')
        || input.code.contains('\0')
        || input.text.contains('\0')
        || input.modifiers > 15
    {
        return Err(AppError::BadArg("invalid browser key input"));
    }
    let Some(target_id) = manager.active_target(&app, &agent_id).await? else {
        return Ok(());
    };
    let (cdp, session_id) = manager.target_session(&app, &target_id).await?;
    if input.kind == "text" {
        cdp.call(
            "Input.insertText",
            json!({ "text": input.text }),
            Some(&session_id),
        )
        .await?;
        return Ok(());
    }
    cdp.call(
        "Input.dispatchKeyEvent",
        json!({
            "type": if input.kind == "up" { "keyUp" } else { "keyDown" },
            "key": input.key,
            "code": input.code,
            "text": input.text,
            "modifiers": input.modifiers
        }),
        Some(&session_id),
    )
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{normalize_url, validate_agent_id, validate_target_id, validate_url_input};

    #[test]
    fn normalizes_addresses_and_searches() {
        assert_eq!(normalize_url("about:blank"), "about:blank");
        assert_eq!(normalize_url("localhost:1420"), "http://localhost:1420");
        assert_eq!(normalize_url("example.com"), "https://example.com");
        assert_eq!(
            normalize_url("browser use"),
            "https://www.google.com/search?q=browser+use"
        );
    }

    #[test]
    fn browser_agent_ids_are_path_safe() {
        assert!(validate_agent_id("agent-codex_42").is_ok());
        assert!(validate_agent_id("../profile").is_err());
        assert!(validate_agent_id("").is_err());
    }

    #[test]
    fn browser_target_and_url_inputs_are_bounded() {
        assert!(validate_target_id("A07f42").is_ok());
        assert!(validate_target_id("../tab").is_err());
        assert!(validate_url_input("https://example.com").is_ok());
        assert!(validate_url_input("https://example.com\nheader: value").is_err());
        assert!(validate_url_input(&"x".repeat(16 * 1024 + 1)).is_err());
    }
}

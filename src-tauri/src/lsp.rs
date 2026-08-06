// Minimal LSP client foundation: spawn a language server per (project, lang),
// frame JSON-RPC over stdio (Content-Length headers), correlate request/
// response pairs.

use std::collections::HashMap;
#[cfg(unix)]
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::AppHandle;
use tokio::task;
use url::Url;

use crate::error::{AppError, AppResult};

const MAX_LSP_FRAME_BYTES: usize = 8 * 1024 * 1024;
const MAX_LSP_HEADER_BYTES: usize = 8 * 1024;

fn lsp<E: std::fmt::Display>(e: E) -> AppError {
    AppError::Lsp(e.to_string())
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct LspPos {
    pub line: u32,
    pub character: u32,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct LspRange {
    pub start: LspPos,
    pub end: LspPos,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct LspLocation {
    pub uri: String,
    pub range: LspRange,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct LspTextChange {
    pub range: Option<LspRange>,
    #[serde(rename = "rangeLength")]
    pub range_length: Option<u32>,
    pub text: String,
}

struct OpenDoc {
    refs: usize,
    version: u32,
}

// Stdin and the pending map are independent — splitting them lets the reader
// thread deliver responses while a writer is mid-flight.
//
// `child` is held so `lsp_stop` can SIGKILL the server process; without it
// the language server would outlive every session that ever opened it.
// `shutdown` flips true once a stop has been issued — readers and writers
// check it so they bail without spamming errors as the child dies.
struct Server {
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
    next_id: Mutex<i64>,
    pending: Mutex<HashMap<i64, mpsc::Sender<Value>>>,
    // Per-(path) hash of last full didChange/didOpen payload — drops no-op
    // resends. Incremental edits clear the hash because the backend no longer
    // has the full text to compare.
    last_change: Mutex<HashMap<String, u64>>,
    // Backend-owned open-document refcounts + monotonically increasing LSP
    // versions. The frontend can have several editor panes pointed at the same
    // URI; the server must still see exactly one didOpen and one didClose.
    open_docs: Mutex<HashMap<String, OpenDoc>>,
    shutdown: std::sync::atomic::AtomicBool,
    /// Logical LRU stamp, bumped on every message we send. The backstop cap
    /// evicts the smallest (least-recently-used) when too many servers pile
    /// up. See `enforce_server_cap`.
    last_used: std::sync::atomic::AtomicU64,
    /// Invalidates a pending idle shutdown whenever a document reopens.
    idle_generation: std::sync::atomic::AtomicU64,
}

type ServerHandle = Arc<Server>;

/// Monotonic logical clock for LRU ordering — cheaper and jump-proof vs
/// wall-clock time; we only need relative ordering, not real timestamps.
fn lsp_tick() -> u64 {
    static CLOCK: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    CLOCK.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

fn registry() -> &'static Mutex<HashMap<String, ServerHandle>> {
    static R: OnceLock<Mutex<HashMap<String, ServerHandle>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(HashMap::new()))
}

fn start_lock() -> &'static Mutex<()> {
    static L: OnceLock<Mutex<()>> = OnceLock::new();
    L.get_or_init(|| Mutex::new(()))
}

fn key(project: &str, language: &str) -> String {
    format!("{language}::{project}")
}

fn server_for(project: &str, language: &str) -> Option<ServerHandle> {
    registry()
        .lock()
        .ok()?
        .get(&key(project, language))
        .cloned()
}

pub fn server_count() -> usize {
    registry().lock().map(|r| r.len()).unwrap_or(0)
}

pub fn document_counts() -> (usize, usize) {
    registry()
        .lock()
        .map(|registry| {
            let mut open_documents = 0usize;
            let mut idle_servers = 0usize;
            for server in registry.values() {
                match server.open_docs.lock() {
                    Ok(docs) if docs.is_empty() => idle_servers += 1,
                    Ok(docs) => open_documents += docs.len(),
                    Err(_) => {}
                }
            }
            (open_documents, idle_servers)
        })
        .unwrap_or_default()
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    fs::metadata(path)
        .map(|m| m.is_file() && (m.permissions().mode() & 0o111) != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

fn executable_in_path(bin: &str) -> Option<PathBuf> {
    crate::system::find_executable(bin)
}

fn go_env(name: &str) -> Option<String> {
    let output = Command::new("go").args(["env", name]).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!value.is_empty()).then_some(value)
}

fn go_path_list(name: &str) -> Vec<PathBuf> {
    go_env(name)
        .map(|value| std::env::split_paths(&std::ffi::OsString::from(value)).collect())
        .unwrap_or_default()
}

fn go_lsp_path() -> Option<PathBuf> {
    executable_in_path("gopls")
        .or_else(|| {
            std::env::var_os("HOME")
                .map(PathBuf::from)
                .and_then(|home| path_if_executable(home.join("go").join("bin").join("gopls")))
        })
        .or_else(|| {
            go_path_list("GOBIN")
                .into_iter()
                .find_map(|p| path_if_executable(p.join("gopls")))
        })
        .or_else(|| {
            go_path_list("GOPATH")
                .into_iter()
                .find_map(|p| path_if_executable(p.join("bin").join("gopls")))
        })
}

fn path_if_executable(path: PathBuf) -> Option<PathBuf> {
    is_executable(&path).then_some(path)
}

fn path_string(path: PathBuf) -> String {
    path.to_string_lossy().into_owned()
}

// (bin, args) tuple for a language. Order matters only for display.
//
// Built-in table covers the common cases; users override or extend per-
// language via an env var `SIKEMUX_LSP_<UPPER_LANG>="<bin> <arg>..."`.
// Example: `SIKEMUX_LSP_RUST="rust-analyzer --log /tmp/ra.log"`. The
// override applies to any matching language, including ones we didn't
// ship with — e.g. `SIKEMUX_LSP_LUA="lua-language-server"`.
const BUILTIN_LSP: &[(&str, &str, &[&str])] = &[
    ("typescript", "typescript-language-server", &["--stdio"]),
    ("javascript", "typescript-language-server", &["--stdio"]),
    ("go", "gopls", &[]),
    ("rust", "rust-analyzer", &[]),
    ("python", "pyright-langserver", &["--stdio"]),
];

fn server_command(language: &str) -> Option<(String, Vec<String>)> {
    let env_key = format!("SIKEMUX_LSP_{}", language.to_uppercase());
    if let Ok(spec) = std::env::var(&env_key) {
        // Naive split — sufficient for "bin arg1 arg2". Quoted args aren't
        // supported; users that need them can wrap in a shell script.
        let mut parts = spec.split_whitespace();
        let bin = parts.next()?.to_string();
        let args = parts.map(|s| s.to_string()).collect();
        return Some((bin, args));
    }
    for (lang, bin, args) in BUILTIN_LSP {
        if *lang == language {
            let resolved_bin = if language == "go" && *bin == "gopls" {
                go_lsp_path()
                    .map(path_string)
                    .unwrap_or_else(|| (*bin).to_string())
            } else {
                (*bin).to_string()
            };
            return Some((
                resolved_bin,
                args.iter().map(|s| (*s).to_string()).collect(),
            ));
        }
    }
    None
}

fn path_to_uri(path: &str) -> String {
    Url::from_file_path(path)
        .map(|u| u.to_string())
        .unwrap_or_else(|_| format!("file://{}", path))
}

fn content_hash(content: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    content.hash(&mut hasher);
    hasher.finish()
}

fn next_doc_version(server: &ServerHandle, path: &str, requested: u32) -> u32 {
    if let Ok(mut docs) = server.open_docs.lock() {
        if let Some(doc) = docs.get_mut(path) {
            let next = requested.max(doc.version.saturating_add(1));
            doc.version = next;
            return next;
        }
    }
    requested
}

fn write_frame(stdin: &mut ChildStdin, msg: &Value) -> AppResult<()> {
    let body = serde_json::to_string(msg)?;
    if body.len() > MAX_LSP_FRAME_BYTES {
        return Err(AppError::Lsp(format!(
            "outbound LSP frame exceeds {} bytes",
            MAX_LSP_FRAME_BYTES
        )));
    }
    let header = format!("Content-Length: {}\r\n\r\n", body.len());
    stdin.write_all(header.as_bytes())?;
    stdin.write_all(body.as_bytes())?;
    stdin.flush()?;
    Ok(())
}

fn send(server: &ServerHandle, msg: &Value) -> AppResult<()> {
    if server.shutdown.load(std::sync::atomic::Ordering::Relaxed) {
        return Err(AppError::Lsp("server shut down".into()));
    }
    server
        .last_used
        .store(lsp_tick(), std::sync::atomic::Ordering::Relaxed);
    let mut guard = server.stdin.lock().map_err(lsp)?;
    let stdin = guard
        .as_mut()
        .ok_or_else(|| AppError::Lsp("stdin gone".into()))?;
    write_frame(stdin, msg)
}

fn read_message<R: BufRead>(reader: &mut R) -> AppResult<Option<Value>> {
    let mut content_length: usize = 0;
    let mut header_bytes = 0usize;
    loop {
        let mut bytes = Vec::new();
        let remaining = MAX_LSP_HEADER_BYTES.saturating_sub(header_bytes);
        if remaining == 0 {
            return Err(AppError::Lsp("LSP headers exceed size limit".into()));
        }
        let n = reader
            .take((remaining + 1) as u64)
            .read_until(b'\n', &mut bytes)?;
        if n == 0 {
            return Ok(None);
        }
        header_bytes = header_bytes.saturating_add(n);
        if header_bytes > MAX_LSP_HEADER_BYTES || !bytes.ends_with(b"\n") {
            return Err(AppError::Lsp("LSP headers exceed size limit".into()));
        }
        let line = std::str::from_utf8(&bytes).map_err(lsp)?;
        let line = line.trim_end_matches(['\r', '\n']);
        if line.is_empty() {
            break;
        }
        if let Some(v) = line.strip_prefix("Content-Length:") {
            content_length = v.trim().parse().map_err(lsp)?;
            if content_length > MAX_LSP_FRAME_BYTES {
                return Err(AppError::Lsp(format!(
                    "LSP frame exceeds {} bytes",
                    MAX_LSP_FRAME_BYTES
                )));
            }
        }
    }
    if content_length == 0 {
        return Err(AppError::Lsp("missing or empty Content-Length".into()));
    }
    let mut buf = vec![0u8; content_length];
    reader.read_exact(&mut buf)?;
    Ok(Some(serde_json::from_slice(&buf)?))
}

fn next_id(server: &ServerHandle) -> i64 {
    // If the mutex is poisoned a request thread crashed mid-allocate.
    // Recover the inner counter instead of crashing the whole LSP layer —
    // a duplicate id is preferable to a panic taking the editor down.
    let mut id = server.next_id.lock().unwrap_or_else(|p| p.into_inner());
    let v = *id;
    *id += 1;
    v
}

fn request_with_timeout(
    server: &ServerHandle,
    method: &str,
    params: Value,
    timeout: Duration,
) -> AppResult<Value> {
    let id = next_id(server);
    let (tx, rx) = mpsc::channel();
    {
        let mut pending = server.pending.lock().map_err(lsp)?;
        pending.insert(id, tx);
    }
    let req = json!({
        "jsonrpc": "2.0", "id": id,
        "method": method, "params": params
    });
    if let Err(e) = send(server, &req) {
        server.pending.lock().ok().and_then(|mut p| p.remove(&id));
        return Err(e);
    }
    match rx.recv_timeout(timeout) {
        Ok(v) => Ok(v),
        Err(e) => {
            if let Ok(mut pending) = server.pending.lock() {
                pending.remove(&id);
            }
            Err(AppError::Lsp(format!("{method} timeout: {e}")))
        }
    }
}

fn request(server: &ServerHandle, method: &str, params: Value) -> AppResult<Value> {
    request_with_timeout(server, method, params, Duration::from_secs(4))
}

fn notify(server: &ServerHandle, method: &str, params: Value) -> AppResult<()> {
    let n = json!({"jsonrpc": "2.0", "method": method, "params": params});
    send(server, &n)
}

fn response_for_server_request(method: &str, params: &Value) -> Value {
    match method {
        // gopls / rust-analyzer / pyright may ask for workspace config during
        // initialization. Returning null here can make them treat the client as
        // broken; an empty object per requested item is the safe fast default.
        "workspace/configuration" => {
            let n = params
                .get("items")
                .and_then(|v| v.as_array())
                .map(|a| a.len())
                .unwrap_or(1);
            Value::Array((0..n).map(|_| json!({})).collect())
        }
        "window/workDoneProgress/create"
        | "client/registerCapability"
        | "client/unregisterCapability" => Value::Null,
        _ => Value::Null,
    }
}

struct SpawnedProcessGuard(Option<Child>);

impl SpawnedProcessGuard {
    fn child_mut(&mut self) -> &mut Child {
        self.0.as_mut().expect("spawned process guard empty")
    }

    fn into_inner(mut self) -> Child {
        self.0.take().expect("spawned process guard empty")
    }
}

impl Drop for SpawnedProcessGuard {
    fn drop(&mut self) {
        if let Some(mut child) = self.0.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn spawn_server(project: &str, language: &str, app: AppHandle) -> AppResult<ServerHandle> {
    let (bin, args) = server_command(language)
        .ok_or_else(|| AppError::Lsp(format!("no language server configured for `{language}`")))?;
    let child = Command::new(&bin)
        .args(&args)
        .current_dir(project)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                AppError::LspServerMissing {
                    language: language.to_string(),
                    bin: bin.clone(),
                }
            } else {
                AppError::Lsp(format!("spawn {bin}: {e}"))
            }
        })?;
    let mut child = SpawnedProcessGuard(Some(child));
    let stdin = child
        .child_mut()
        .stdin
        .take()
        .ok_or(AppError::Lsp("no stdin".into()))?;
    let stdout = child
        .child_mut()
        .stdout
        .take()
        .ok_or(AppError::Lsp("no stdout".into()))?;
    let stderr = child.child_mut().stderr.take();
    let child = child.into_inner();

    let server = Arc::new(Server {
        child: Mutex::new(Some(child)),
        stdin: Mutex::new(Some(stdin)),
        next_id: Mutex::new(1),
        pending: Mutex::new(HashMap::new()),
        last_change: Mutex::new(HashMap::new()),
        open_docs: Mutex::new(HashMap::new()),
        shutdown: std::sync::atomic::AtomicBool::new(false),
        last_used: std::sync::atomic::AtomicU64::new(lsp_tick()),
        idle_generation: std::sync::atomic::AtomicU64::new(0),
    });

    let reader_server = server.clone();
    let _ = app;
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        while let Ok(Some(msg)) = read_message(&mut reader) {
            if reader_server
                .shutdown
                .load(std::sync::atomic::Ordering::Relaxed)
            {
                break;
            }
            if let Some(id_value) = msg.get("id").cloned() {
                if let Some(method) = msg.get("method").and_then(|m| m.as_str()) {
                    // Server-initiated request — reply with a shape the common
                    // language servers accept so they don't stall or downgrade
                    // features while waiting on client config/progress support.
                    let result = response_for_server_request(
                        method,
                        msg.get("params").unwrap_or(&Value::Null),
                    );
                    let reply = json!({"jsonrpc": "2.0", "id": id_value, "result": result});
                    let _ = send(&reader_server, &reply);
                } else if let Some(id) = id_value.as_i64() {
                    if let Ok(mut pending) = reader_server.pending.lock() {
                        if let Some(tx) = pending.remove(&id) {
                            let val = msg.get("result").cloned().unwrap_or(Value::Null);
                            let _ = tx.send(val);
                        }
                    }
                }
            }
        }
        // Reader exit unblocks any pending RPC waiters so they fail fast
        // instead of timing out. It also owns teardown for malformed frames or
        // natural server exit; otherwise the registry would retain an unusable
        // server forever and later lsp_start calls would falsely succeed.
        if let Ok(mut pending) = reader_server.pending.lock() {
            pending.clear();
        }
        shutdown_server(reader_server);
    });

    // Drain stderr on its own thread. rust-analyzer / pyright emit a LOT of
    // log noise on stderr; without draining, the OS pipe fills and write()
    // calls inside the server start to block, freezing hover / definition
    // with no obvious cause.
    if let Some(stderr) = stderr {
        let drain_server = server.clone();
        thread::spawn(move || {
            let mut reader = BufReader::new(stderr);
            let mut sink = String::new();
            loop {
                if drain_server
                    .shutdown
                    .load(std::sync::atomic::Ordering::Relaxed)
                {
                    break;
                }
                sink.clear();
                match reader.read_line(&mut sink) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => continue,
                }
            }
        });
    }

    let init = json!({
        "processId": std::process::id(),
        "rootUri": path_to_uri(project),
        "capabilities": {
            "textDocument": {
                "synchronization": {
                    "dynamicRegistration": false,
                    "willSave": false,
                    "willSaveWaitUntil": false,
                    "didSave": true
                },
                "definition": { "linkSupport": false },
                "implementation": { "linkSupport": false },
                "references": {},
                "hover": { "contentFormat": ["markdown", "plaintext"] },
                "completion": { "completionItem": { "snippetSupport": false } },
                "publishDiagnostics": { "relatedInformation": false }
            },
            "workspace": {
                "workspaceFolders": true,
                "configuration": true
            }
        },
        "workspaceFolders": [{ "uri": path_to_uri(project), "name": project }]
    });
    if let Err(error) = request_with_timeout(&server, "initialize", init, Duration::from_secs(20))
        .and_then(|_| notify(&server, "initialized", json!({})))
    {
        shutdown_server(server.clone());
        return Err(error);
    }
    Ok(server)
}

/// Generous backstop on concurrent language servers. This is deliberately
/// NOT active management: rust-analyzer / gopls re-index on restart, so
/// evicting a server the user is about to use trades a multi-second stall
/// for a little RAM. The frontend already stops a project's servers when
/// the project closes (`lsp_stop`), so in normal use the live set == open
/// projects. This cap only bites in the pathological case (a stop that
/// never arrived, or an extreme number of simultaneously-open projects),
/// where something has to give and the least-recently-touched project is
/// the least-bad victim. Keep it high enough that ordinary multi-project
/// work never trips it.
const MAX_LSP_SERVERS: usize = 6;
const LSP_IDLE_GRACE: Duration = Duration::from_secs(5 * 60);

fn schedule_idle_shutdown(server_key: String, server: ServerHandle) {
    let generation = server
        .idle_generation
        .fetch_add(1, std::sync::atomic::Ordering::AcqRel)
        .saturating_add(1);
    task::spawn(async move {
        tokio::time::sleep(LSP_IDLE_GRACE).await;
        if server.shutdown.load(std::sync::atomic::Ordering::Acquire)
            || server
                .idle_generation
                .load(std::sync::atomic::Ordering::Acquire)
                != generation
            || server
                .open_docs
                .lock()
                .map(|docs| !docs.is_empty())
                .unwrap_or(true)
        {
            return;
        }
        let victim = registry().lock().ok().and_then(|mut reg| {
            let current = reg.get(&server_key)?;
            if !Arc::ptr_eq(current, &server) {
                return None;
            }
            reg.remove(&server_key)
        });
        if let Some(victim) = victim {
            let _ = task::spawn_blocking(move || shutdown_server(victim)).await;
        }
    });
}

/// SIGKILL + reap a server. Shared by `lsp_stop` and the backstop cap.
fn shutdown_server(server: ServerHandle) {
    server
        .shutdown
        .store(true, std::sync::atomic::Ordering::Relaxed);
    // Drop stdin so the server's read loop sees EOF and exits cleanly; if
    // it doesn't, fall through to kill().
    if let Ok(mut g) = server.stdin.lock() {
        g.take();
    }
    if let Ok(mut g) = server.child.lock() {
        if let Some(mut c) = g.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

/// Return true only for a usable registry entry. Reader-owned teardown marks
/// failed/exited servers shut down; remove those entries so a subsequent start
/// can actually spawn a replacement.
fn live_server_exists(key: &str) -> AppResult<bool> {
    let stale = {
        let mut registry = registry().lock().map_err(lsp)?;
        match registry.get(key) {
            Some(server) if !server.shutdown.load(std::sync::atomic::Ordering::Relaxed) => {
                return Ok(true)
            }
            Some(_) => registry.remove(key),
            None => None,
        }
    };
    if let Some(server) = stale {
        shutdown_server(server);
    }
    Ok(false)
}

/// Application-teardown backstop for servers whose project stop never arrived.
pub fn drain_all() {
    let servers = registry()
        .lock()
        .map(|mut registry| {
            registry
                .drain()
                .map(|(_, server)| server)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    for server in servers {
        shutdown_server(server);
    }
}

/// If we're over `MAX_LSP_SERVERS`, evict the least-recently-used server
/// (never the one just started). The kill happens off-thread.
fn enforce_server_cap(just_started: &str) {
    let victim_key = {
        let reg = match registry().lock() {
            Ok(r) => r,
            Err(_) => return,
        };
        if reg.len() <= MAX_LSP_SERVERS {
            return;
        }
        reg.iter()
            .filter(|(k, server)| {
                k.as_str() != just_started
                    && server
                        .open_docs
                        .lock()
                        .map(|docs| docs.is_empty())
                        .unwrap_or(false)
            })
            .min_by_key(|(_, s)| s.last_used.load(std::sync::atomic::Ordering::Relaxed))
            .map(|(k, _)| k.clone())
    };
    let Some(key) = victim_key else { return };
    let victim = registry().lock().ok().and_then(|mut r| r.remove(&key));
    if let Some(server) = victim {
        task::spawn_blocking(move || shutdown_server(server));
    }
}

fn install_output_message(stdout: &[u8], stderr: &[u8]) -> String {
    let stderr = String::from_utf8_lossy(stderr).trim().to_string();
    if !stderr.is_empty() {
        return stderr;
    }
    let stdout = String::from_utf8_lossy(stdout).trim().to_string();
    if stdout.is_empty() {
        "unknown failure".into()
    } else {
        stdout
    }
}

fn install_gopls() -> AppResult<String> {
    let output = Command::new("go")
        .args(["install", "golang.org/x/tools/gopls@latest"])
        .output()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                AppError::Lsp(
                    "Go toolchain not found on PATH. Install Go first: https://go.dev/doc/install"
                        .into(),
                )
            } else {
                AppError::Lsp(format!("run go install gopls: {e}"))
            }
        })?;
    if !output.status.success() {
        return Err(AppError::Lsp(format!(
            "go install golang.org/x/tools/gopls@latest failed: {}",
            install_output_message(&output.stdout, &output.stderr)
        )));
    }
    go_lsp_path().map(path_string).ok_or_else(|| {
        AppError::Lsp(
            "gopls installed, but Sikemux could not locate it in PATH, GOBIN, or GOPATH/bin".into(),
        )
    })
}

// ---- Tauri commands -----------------------------------------------------

#[tauri::command]
pub async fn lsp_install_server(language: String) -> AppResult<String> {
    match language.as_str() {
        "go" => task::spawn_blocking(install_gopls)
            .await
            .map_err(|e| AppError::Lsp(format!("join: {e}")))?,
        _ => Err(AppError::Lsp(format!(
            "no language-server installer configured for `{language}`"
        ))),
    }
}

#[tauri::command]
pub async fn lsp_start(app: AppHandle, project: String, language: String) -> AppResult<()> {
    let k = key(&project, &language);
    if live_server_exists(&k)? {
        return Ok(());
    }
    let cap_key = k.clone();
    // The initialize handshake blocks up to 20 s on slow servers; off the
    // Tauri worker pool so unrelated IPC isn't starved. A small start lock
    // prevents two concurrent opens of the same language from spawning two
    // gopls/rust-analyzer processes before either one reaches the registry.
    let inserted = task::spawn_blocking(move || -> AppResult<bool> {
        let _guard = start_lock().lock().map_err(lsp)?;
        if live_server_exists(&k)? {
            return Ok(false);
        }
        let server = spawn_server(&project, &language, app)?;
        registry().lock().map_err(lsp)?.insert(k, server);
        Ok(true)
    })
    .await
    .map_err(|e| AppError::Lsp(format!("join: {e}")))??;
    if inserted {
        // Backstop: keep the concurrent-server count bounded (see the const).
        enforce_server_cap(&cap_key);
    }
    Ok(())
}

/// Shut every server owned by this project down. Called from the close-
/// session path so a long-running rust-analyzer doesn't hang around with
/// 500 MB resident after the user moves on. Idempotent.
#[tauri::command]
pub async fn lsp_stop(project: String) -> AppResult<()> {
    let prefix_suffix = format!("::{project}");
    let mut to_kill: Vec<ServerHandle> = Vec::new();
    if let Ok(mut reg) = registry().lock() {
        let keys: Vec<String> = reg
            .keys()
            .filter(|k| k.ends_with(&prefix_suffix))
            .cloned()
            .collect();
        for k in keys {
            if let Some(s) = reg.remove(&k) {
                to_kill.push(s);
            }
        }
    }
    // Actual kill is potentially slow (SIGKILL + wait); off-thread.
    task::spawn_blocking(move || {
        for server in to_kill {
            shutdown_server(server);
        }
    })
    .await
    .map_err(|e| AppError::Lsp(format!("join: {e}")))?;
    Ok(())
}

#[tauri::command]
pub async fn lsp_open(
    project: String,
    language: String,
    path: String,
    content: String,
    language_id: Option<String>,
) -> AppResult<()> {
    let server =
        server_for(&project, &language).ok_or(AppError::Lsp("server not started".into()))?;
    server
        .idle_generation
        .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
    task::spawn_blocking(move || {
        let language_id = language_id.unwrap_or(language);
        let hash = content_hash(&content);
        let mut should_open = false;
        let mut change_version: Option<u32> = None;
        {
            let mut docs = server.open_docs.lock().map_err(lsp)?;
            if let Some(doc) = docs.get_mut(&path) {
                doc.refs += 1;
                let mut last = server.last_change.lock().map_err(lsp)?;
                if last.get(&path) != Some(&hash) {
                    doc.version = doc.version.saturating_add(1);
                    change_version = Some(doc.version);
                    last.insert(path.clone(), hash);
                }
            } else {
                docs.insert(
                    path.clone(),
                    OpenDoc {
                        refs: 1,
                        version: 1,
                    },
                );
                server
                    .last_change
                    .lock()
                    .map_err(lsp)?
                    .insert(path.clone(), hash);
                should_open = true;
            }
        }
        if should_open {
            notify(
                &server,
                "textDocument/didOpen",
                json!({
                    "textDocument": {
                        "uri": path_to_uri(&path),
                        "languageId": language_id,
                        "version": 1,
                        "text": content
                    }
                }),
            )
        } else if let Some(version) = change_version {
            notify(
                &server,
                "textDocument/didChange",
                json!({
                    "textDocument": { "uri": path_to_uri(&path), "version": version },
                    "contentChanges": [{ "text": content }]
                }),
            )
        } else {
            Ok(())
        }
    })
    .await
    .map_err(|e| AppError::Lsp(format!("join: {e}")))?
}

#[tauri::command]
pub async fn lsp_change(
    project: String,
    language: String,
    path: String,
    content: String,
    version: u32,
) -> AppResult<()> {
    let server =
        server_for(&project, &language).ok_or(AppError::Lsp("server not started".into()))?;
    // Cheap content-hash dedup: if the previous full payload for this path
    // hashed to the same value, skip the IPC + LSP reparse.
    let h = content_hash(&content);
    if let Ok(mut last) = server.last_change.lock() {
        if last.get(&path) == Some(&h) {
            return Ok(());
        }
        last.insert(path.clone(), h);
    }
    let version = next_doc_version(&server, &path, version);
    task::spawn_blocking(move || {
        notify(
            &server,
            "textDocument/didChange",
            json!({
                "textDocument": { "uri": path_to_uri(&path), "version": version },
                "contentChanges": [{ "text": content }]
            }),
        )
    })
    .await
    .map_err(|e| AppError::Lsp(format!("join: {e}")))?
}

#[tauri::command]
pub async fn lsp_change_incremental(
    project: String,
    language: String,
    path: String,
    changes: Vec<LspTextChange>,
    version: u32,
) -> AppResult<()> {
    if changes.is_empty() {
        return Ok(());
    }
    let server =
        server_for(&project, &language).ok_or(AppError::Lsp("server not started".into()))?;
    if let Ok(mut last) = server.last_change.lock() {
        last.remove(&path);
    }
    let version = next_doc_version(&server, &path, version);
    task::spawn_blocking(move || {
        notify(
            &server,
            "textDocument/didChange",
            json!({
                "textDocument": { "uri": path_to_uri(&path), "version": version },
                "contentChanges": changes
            }),
        )
    })
    .await
    .map_err(|e| AppError::Lsp(format!("join: {e}")))?
}

#[tauri::command]
pub async fn lsp_save(
    project: String,
    language: String,
    path: String,
    content: Option<String>,
) -> AppResult<()> {
    let Some(server) = server_for(&project, &language) else {
        return Ok(());
    };
    task::spawn_blocking(move || {
        let mut params = json!({ "textDocument": { "uri": path_to_uri(&path) } });
        if let Some(text) = content {
            params["text"] = json!(text);
        }
        notify(&server, "textDocument/didSave", params)
    })
    .await
    .map_err(|e| AppError::Lsp(format!("join: {e}")))?
}

#[tauri::command]
pub async fn lsp_close(project: String, language: String, path: String) -> AppResult<()> {
    let Some(server) = server_for(&project, &language) else {
        return Ok(());
    };
    let server_key = key(&project, &language);
    let idle_server = server.clone();
    let became_idle = task::spawn_blocking(move || -> AppResult<bool> {
        let mut should_close = false;
        let mut became_idle = false;
        {
            let mut docs = server.open_docs.lock().map_err(lsp)?;
            if let Some(doc) = docs.get_mut(&path) {
                if doc.refs > 1 {
                    doc.refs -= 1;
                } else {
                    docs.remove(&path);
                    should_close = true;
                    became_idle = docs.is_empty();
                }
            }
        }
        if !should_close {
            return Ok(false);
        }
        if let Ok(mut last) = server.last_change.lock() {
            last.remove(&path);
        }
        notify(
            &server,
            "textDocument/didClose",
            json!({ "textDocument": { "uri": path_to_uri(&path) } }),
        )?;
        Ok(became_idle)
    })
    .await
    .map_err(|e| AppError::Lsp(format!("join: {e}")))??;
    if became_idle {
        schedule_idle_shutdown(server_key, idle_server);
    }
    Ok(())
}

fn parse_location_like(v: &Value) -> Option<LspLocation> {
    if let Ok(loc) = serde_json::from_value::<LspLocation>(v.clone()) {
        return Some(loc);
    }
    let uri = v
        .get("targetUri")
        .or_else(|| v.get("uri"))?
        .as_str()?
        .to_string();
    let range_value = v
        .get("targetSelectionRange")
        .or_else(|| v.get("targetRange"))
        .or_else(|| v.get("range"))?;
    let range = serde_json::from_value::<LspRange>(range_value.clone()).ok()?;
    Some(LspLocation { uri, range })
}

fn parse_locations(result: &Value) -> Vec<LspLocation> {
    if result.is_null() {
        return vec![];
    }
    if let Some(arr) = result.as_array() {
        return arr.iter().filter_map(parse_location_like).collect();
    }
    parse_location_like(result).into_iter().collect()
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub enum LspKind {
    Definition,
    Declaration,
    TypeDefinition,
    Implementation,
    References,
}

#[tauri::command]
pub async fn lsp_locations(
    project: String,
    language: String,
    path: String,
    line: u32,
    character: u32,
    kind: LspKind,
) -> AppResult<Vec<LspLocation>> {
    let server =
        server_for(&project, &language).ok_or(AppError::Lsp("server not started".into()))?;
    let (method, with_context) = match kind {
        LspKind::Definition => ("textDocument/definition", false),
        LspKind::Declaration => ("textDocument/declaration", false),
        LspKind::TypeDefinition => ("textDocument/typeDefinition", false),
        LspKind::Implementation => ("textDocument/implementation", false),
        LspKind::References => ("textDocument/references", true),
    };
    let mut params = json!({
        "textDocument": { "uri": path_to_uri(&path) },
        "position": { "line": line, "character": character }
    });
    if with_context {
        params["context"] = json!({ "includeDeclaration": false });
    }
    let result = task::spawn_blocking(move || request(&server, method, params))
        .await
        .map_err(|e| AppError::Lsp(format!("join: {e}")))??;
    Ok(parse_locations(&result))
}

#[cfg(test)]
mod tests {
    use super::{read_message, MAX_LSP_FRAME_BYTES, MAX_LSP_HEADER_BYTES};
    use serde_json::json;
    use std::io::{BufReader, Cursor};

    #[test]
    fn reads_bounded_lsp_frame() {
        let body = br#"{"jsonrpc":"2.0","id":1,"result":null}"#;
        let mut frame = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
        frame.extend_from_slice(body);
        let mut reader = BufReader::new(Cursor::new(frame));

        assert_eq!(
            read_message(&mut reader).expect("frame"),
            Some(json!({
                "jsonrpc": "2.0", "id": 1, "result": null
            }))
        );
    }

    #[test]
    fn rejects_oversized_lsp_frame_before_allocating_body() {
        let frame = format!("Content-Length: {}\r\n\r\n", MAX_LSP_FRAME_BYTES + 1);
        let mut reader = BufReader::new(Cursor::new(frame.into_bytes()));
        let error = read_message(&mut reader).expect_err("oversized frame");
        assert!(error.to_string().contains("exceeds"));
    }

    #[test]
    fn rejects_oversized_lsp_headers() {
        let frame = format!("X-Long: {}\r\n\r\n", "x".repeat(MAX_LSP_HEADER_BYTES));
        let mut reader = BufReader::new(Cursor::new(frame.into_bytes()));
        let error = read_message(&mut reader).expect_err("oversized headers");
        assert!(error.to_string().contains("headers exceed"));
    }
}

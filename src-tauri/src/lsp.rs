// Minimal LSP client foundation: spawn a language server per (project, lang),
// frame JSON-RPC over stdio (Content-Length headers), correlate request/
// response pairs.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::AppHandle;
use tokio::task;

use crate::error::{AppError, AppResult};

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
    // Per-(path) hash of last didChange payload — drops no-op resends
    // (rare, but the 300 ms debounce can land an identical doc when the
    // user undoes back to the saved state).
    last_change: Mutex<HashMap<String, u64>>,
    shutdown: std::sync::atomic::AtomicBool,
}

type ServerHandle = Arc<Server>;

fn registry() -> &'static Mutex<HashMap<String, ServerHandle>> {
    static R: OnceLock<Mutex<HashMap<String, ServerHandle>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(HashMap::new()))
}

fn key(project: &str, language: &str) -> String {
    format!("{language}::{project}")
}

fn server_for(project: &str, language: &str) -> Option<ServerHandle> {
    registry().lock().ok()?.get(&key(project, language)).cloned()
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
            return Some((
                (*bin).to_string(),
                args.iter().map(|s| (*s).to_string()).collect(),
            ));
        }
    }
    None
}

fn path_to_uri(path: &str) -> String {
    format!("file://{}", path)
}

fn write_frame(stdin: &mut ChildStdin, msg: &Value) -> AppResult<()> {
    let body = serde_json::to_string(msg)?;
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
    let mut guard = server.stdin.lock().map_err(lsp)?;
    let stdin = guard.as_mut().ok_or_else(|| AppError::Lsp("stdin gone".into()))?;
    write_frame(stdin, msg)
}

fn read_message(reader: &mut BufReader<ChildStdout>) -> Option<Value> {
    let mut content_length: usize = 0;
    loop {
        let mut line = String::new();
        let n = reader.read_line(&mut line).ok()?;
        if n == 0 { return None; }
        let line = line.trim_end_matches(|c| c == '\r' || c == '\n');
        if line.is_empty() { break; }
        if let Some(v) = line.strip_prefix("Content-Length:") {
            content_length = v.trim().parse().ok()?;
        }
    }
    if content_length == 0 { return None; }
    let mut buf = vec![0u8; content_length];
    reader.read_exact(&mut buf).ok()?;
    serde_json::from_slice(&buf).ok()
}

fn next_id(server: &ServerHandle) -> i64 {
    // If the mutex is poisoned a request thread crashed mid-allocate.
    // Recover the inner counter instead of crashing the whole LSP layer —
    // a duplicate id is preferable to a panic taking the editor down.
    let mut id = server
        .next_id
        .lock()
        .unwrap_or_else(|p| p.into_inner());
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
    rx.recv_timeout(timeout)
        .map_err(|e| AppError::Lsp(format!("{method} timeout: {e}")))
}

fn request(server: &ServerHandle, method: &str, params: Value) -> AppResult<Value> {
    request_with_timeout(server, method, params, Duration::from_secs(4))
}

fn notify(server: &ServerHandle, method: &str, params: Value) -> AppResult<()> {
    let n = json!({"jsonrpc": "2.0", "method": method, "params": params});
    send(server, &n)
}

fn spawn_server(
    project: &str,
    language: &str,
    app: AppHandle,
) -> AppResult<ServerHandle> {
    let (bin, args) = server_command(language)
        .ok_or_else(|| AppError::Lsp(format!("no language server configured for `{language}`")))?;
    let mut child = Command::new(&bin)
        .args(&args)
        .current_dir(project)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| AppError::Lsp(format!("spawn {bin}: {e}")))?;
    let stdin = child.stdin.take().ok_or(AppError::Lsp("no stdin".into()))?;
    let stdout = child.stdout.take().ok_or(AppError::Lsp("no stdout".into()))?;
    let stderr = child.stderr.take();

    let server = Arc::new(Server {
        child: Mutex::new(Some(child)),
        stdin: Mutex::new(Some(stdin)),
        next_id: Mutex::new(1),
        pending: Mutex::new(HashMap::new()),
        last_change: Mutex::new(HashMap::new()),
        shutdown: std::sync::atomic::AtomicBool::new(false),
    });

    let reader_server = server.clone();
    let _ = app;
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        while let Some(msg) = read_message(&mut reader) {
            if reader_server.shutdown.load(std::sync::atomic::Ordering::Relaxed) {
                break;
            }
            if let Some(id) = msg.get("id").and_then(|i| i.as_i64()) {
                if msg.get("method").is_some() {
                    // Server-initiated request — reply with null result so
                    // gopls / tsserver don't stall waiting.
                    let reply = json!({"jsonrpc": "2.0", "id": id, "result": Value::Null});
                    let _ = send(&reader_server, &reply);
                } else if let Ok(mut pending) = reader_server.pending.lock() {
                    if let Some(tx) = pending.remove(&id) {
                        let val = msg.get("result").cloned().unwrap_or(Value::Null);
                        let _ = tx.send(val);
                    }
                }
            }
        }
        // Reader exit unblocks any pending RPC waiters so they fail fast
        // instead of timing out — important when lsp_stop is racing us.
        if let Ok(mut pending) = reader_server.pending.lock() {
            pending.clear();
        }
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
                if drain_server.shutdown.load(std::sync::atomic::Ordering::Relaxed) {
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
    request_with_timeout(&server, "initialize", init, Duration::from_secs(20))?;
    notify(&server, "initialized", json!({}))?;
    Ok(server)
}

// ---- Tauri commands -----------------------------------------------------

#[tauri::command]
pub async fn lsp_start(
    app: AppHandle,
    project: String,
    language: String,
) -> AppResult<()> {
    let k = key(&project, &language);
    {
        let reg = registry().lock().map_err(lsp)?;
        if reg.contains_key(&k) { return Ok(()); }
    }
    // The initialize handshake blocks up to 20 s on slow servers; off the
    // Tauri worker pool so unrelated IPC isn't starved.
    let server = task::spawn_blocking(move || spawn_server(&project, &language, app))
        .await
        .map_err(|e| AppError::Lsp(format!("join: {e}")))??;
    registry().lock().map_err(lsp)?.insert(k, server);
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
            server.shutdown.store(true, std::sync::atomic::Ordering::Relaxed);
            // Drop stdin so the server's read loop sees EOF and exits
            // cleanly; if it doesn't, fall through to kill().
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
) -> AppResult<()> {
    let server = server_for(&project, &language)
        .ok_or(AppError::Lsp("server not started".into()))?;
    task::spawn_blocking(move || {
        notify(
            &server,
            "textDocument/didOpen",
            json!({
                "textDocument": {
                    "uri": path_to_uri(&path),
                    "languageId": language,
                    "version": 1,
                    "text": content
                }
            }),
        )
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
    let server = server_for(&project, &language)
        .ok_or(AppError::Lsp("server not started".into()))?;
    // Cheap content-hash dedup: if the previous payload for this path
    // hashed to the same value, skip the IPC + LSP reparse. Catches
    // undo-back-to-saved and the debounce firing without an actual edit.
    let h = {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        content.hash(&mut hasher);
        hasher.finish()
    };
    if let Ok(mut last) = server.last_change.lock() {
        if last.get(&path) == Some(&h) {
            return Ok(());
        }
        last.insert(path.clone(), h);
    }
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

fn parse_locations(result: &Value) -> Vec<LspLocation> {
    if result.is_null() { return vec![]; }
    if let Some(arr) = result.as_array() {
        return arr
            .iter()
            .filter_map(|v| serde_json::from_value::<LspLocation>(v.clone()).ok())
            .collect();
    }
    if let Ok(loc) = serde_json::from_value::<LspLocation>(result.clone()) {
        return vec![loc];
    }
    vec![]
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum LspKind {
    Definition,
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
    let server = server_for(&project, &language)
        .ok_or(AppError::Lsp("server not started".into()))?;
    let (method, with_context) = match kind {
        LspKind::Definition => ("textDocument/definition", false),
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

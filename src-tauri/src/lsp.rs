// Minimal LSP client foundation: spawn a language server per (project, lang),
// frame JSON-RPC over stdio (Content-Length headers), correlate request/
// response pairs.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::AppHandle;

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
struct Server {
    stdin: Mutex<ChildStdin>,
    next_id: Mutex<i64>,
    pending: Mutex<HashMap<i64, mpsc::Sender<Value>>>,
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
    let mut stdin = server.stdin.lock().map_err(lsp)?;
    write_frame(&mut stdin, msg)
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
    let mut id = server.next_id.lock().unwrap();
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

    let server = Arc::new(Server {
        stdin: Mutex::new(stdin),
        next_id: Mutex::new(1),
        pending: Mutex::new(HashMap::new()),
    });

    let reader_server = server.clone();
    let _ = app;
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        while let Some(msg) = read_message(&mut reader) {
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
    });

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
    let server = spawn_server(&project, &language, app)?;
    registry().lock().map_err(lsp)?.insert(k, server);
    Ok(())
}

#[tauri::command]
pub fn lsp_open(
    project: String,
    language: String,
    path: String,
    content: String,
) -> AppResult<()> {
    let server = server_for(&project, &language)
        .ok_or(AppError::Lsp("server not started".into()))?;
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
}

#[tauri::command]
pub fn lsp_change(
    project: String,
    language: String,
    path: String,
    content: String,
    version: u32,
) -> AppResult<()> {
    let server = server_for(&project, &language)
        .ok_or(AppError::Lsp("server not started".into()))?;
    notify(
        &server,
        "textDocument/didChange",
        json!({
            "textDocument": { "uri": path_to_uri(&path), "version": version },
            "contentChanges": [{ "text": content }]
        }),
    )
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
    Ok(parse_locations(&request(&server, method, params)?))
}

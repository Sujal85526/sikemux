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

fn server_command(language: &str) -> Option<(&'static str, Vec<&'static str>)> {
    match language {
        "typescript" | "javascript" => {
            Some(("typescript-language-server", vec!["--stdio"]))
        }
        "go" => Some(("gopls", vec![])),
        "rust" => Some(("rust-analyzer", vec![])),
        "python" => Some(("pyright-langserver", vec!["--stdio"])),
        _ => None,
    }
}

fn path_to_uri(path: &str) -> String {
    format!("file://{}", path)
}

fn write_frame(stdin: &mut ChildStdin, msg: &Value) -> Result<(), String> {
    let body = serde_json::to_string(msg).map_err(|e| e.to_string())?;
    let header = format!("Content-Length: {}\r\n\r\n", body.len());
    stdin.write_all(header.as_bytes()).map_err(|e| e.to_string())?;
    stdin.write_all(body.as_bytes()).map_err(|e| e.to_string())?;
    stdin.flush().map_err(|e| e.to_string())?;
    Ok(())
}

fn send(server: &ServerHandle, msg: &Value) -> Result<(), String> {
    let mut stdin = server.stdin.lock().map_err(|e| e.to_string())?;
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
) -> Result<Value, String> {
    let id = next_id(server);
    let (tx, rx) = mpsc::channel();
    {
        let mut pending = server.pending.lock().map_err(|e| e.to_string())?;
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
        .map_err(|e| format!("lsp {method} timeout: {e}"))
}

fn request(server: &ServerHandle, method: &str, params: Value) -> Result<Value, String> {
    request_with_timeout(server, method, params, Duration::from_secs(4))
}

fn notify(server: &ServerHandle, method: &str, params: Value) -> Result<(), String> {
    let n = json!({"jsonrpc": "2.0", "method": method, "params": params});
    send(server, &n)
}

fn spawn_server(
    project: &str,
    language: &str,
    app: AppHandle,
) -> Result<ServerHandle, String> {
    let (bin, args) = server_command(language)
        .ok_or_else(|| format!("no language server configured for `{language}`"))?;
    let mut child = Command::new(bin)
        .args(&args)
        .current_dir(project)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn {bin}: {e}"))?;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;

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
) -> Result<(), String> {
    let k = key(&project, &language);
    {
        let reg = registry().lock().map_err(|e| e.to_string())?;
        if reg.contains_key(&k) { return Ok(()); }
    }
    let server = spawn_server(&project, &language, app)?;
    registry().lock().map_err(|e| e.to_string())?.insert(k, server);
    Ok(())
}

#[tauri::command]
pub fn lsp_open(
    project: String,
    language: String,
    path: String,
    content: String,
) -> Result<(), String> {
    let server = server_for(&project, &language)
        .ok_or_else(|| "lsp server not started".to_string())?;
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
) -> Result<(), String> {
    let server = server_for(&project, &language)
        .ok_or_else(|| "lsp server not started".to_string())?;
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

#[tauri::command]
pub async fn lsp_locations(
    project: String,
    language: String,
    path: String,
    line: u32,
    character: u32,
    kind: String,
) -> Result<Vec<LspLocation>, String> {
    let server = server_for(&project, &language)
        .ok_or_else(|| "lsp server not started".to_string())?;
    let (method, with_context) = match kind.as_str() {
        "definition" => ("textDocument/definition", false),
        "implementation" => ("textDocument/implementation", false),
        "references" => ("textDocument/references", true),
        other => return Err(format!("unknown lsp kind: {other}")),
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

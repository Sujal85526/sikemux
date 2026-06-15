// HTTP runner for the Bruno (.bru) client. The frontend parses .bru files,
// resolves {{variables}}, and runs pre-request scripts, then hands us a fully
// concrete request to fire. Doing the send in Rust (rather than webview fetch)
// sidesteps CORS, gives true status/timing/size, and exposes raw response
// headers the browser would otherwise hide.

use std::sync::OnceLock;
use std::time::{Duration, Instant};

use reqwest::header::{HeaderMap, HeaderName, HeaderValue, CONTENT_TYPE};
use reqwest::{Client, Method};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

fn client(skip_tls_verify: bool) -> &'static Client {
    static PLAIN: OnceLock<Client> = OnceLock::new();
    static INSECURE: OnceLock<Client> = OnceLock::new();
    let build = |insecure: bool| {
        Client::builder()
            .cookie_store(true)
            .danger_accept_invalid_certs(insecure)
            .user_agent("sikemux-bruno/0.1")
            .build()
            .expect("build reqwest client")
    };
    if skip_tls_verify {
        INSECURE.get_or_init(|| build(true))
    } else {
        PLAIN.get_or_init(|| build(false))
    }
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BruBodyWire {
    None,
    /// Raw payload (json / text / xml / graphql). `content_type` is applied
    /// unless the caller already set a Content-Type header.
    Raw {
        content_type: Option<String>,
        data: String,
    },
    /// Send a local file as the entire request body.
    File {
        path: String,
        content_type: Option<String>,
    },
    /// application/x-www-form-urlencoded
    Form {
        fields: Vec<(String, String)>,
    },
    /// multipart/form-data. File parts carry a local path in `value`.
    Multipart {
        fields: Vec<MultipartField>,
    },
}

#[derive(Deserialize)]
pub struct MultipartField {
    pub name: String,
    pub value: String,
    #[serde(default)]
    pub is_file: bool,
}

#[derive(Deserialize)]
pub struct BruSendRequest {
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub headers: Vec<(String, String)>,
    pub body: BruBodyWire,
    #[serde(default)]
    pub timeout_ms: u64,
    #[serde(default)]
    pub skip_tls_verify: bool,
}

#[derive(Serialize)]
pub struct BruSendResponse {
    pub status: u16,
    pub status_text: String,
    pub headers: Vec<(String, String)>,
    pub body: String,
    pub is_binary: bool,
    pub size_bytes: u64,
    pub duration_ms: u64,
}

fn build_headers(pairs: &[(String, String)]) -> HeaderMap {
    let mut map = HeaderMap::new();
    for (k, v) in pairs {
        let name = match HeaderName::from_bytes(k.as_bytes()) {
            Ok(n) => n,
            Err(_) => continue,
        };
        if let Ok(val) = HeaderValue::from_str(v) {
            map.append(name, val);
        }
    }
    map
}

#[tauri::command]
pub async fn bru_send(req: BruSendRequest) -> AppResult<BruSendResponse> {
    let method = Method::from_bytes(req.method.to_uppercase().as_bytes()).map_err(|_| AppError::BadArg("invalid HTTP method"))?;
    if req.url.trim().is_empty() {
        return Err(AppError::BadArg("empty URL"));
    }

    let mut headers = build_headers(&req.headers);
    let cl = client(req.skip_tls_verify);
    let mut builder = cl.request(method, &req.url);

    match req.body {
        BruBodyWire::None => {}
        BruBodyWire::Raw { content_type, data } => {
            if let Some(ct) = content_type {
                if !headers.contains_key(CONTENT_TYPE) {
                    if let Ok(val) = HeaderValue::from_str(&ct) {
                        headers.insert(CONTENT_TYPE, val);
                    }
                }
            }
            builder = builder.body(data);
        }
        BruBodyWire::File { path, content_type } => {
            if let Some(ct) = content_type {
                if !headers.contains_key(CONTENT_TYPE) {
                    if let Ok(val) = HeaderValue::from_str(&ct) {
                        headers.insert(CONTENT_TYPE, val);
                    }
                }
            }
            let bytes = tokio::fs::read(&path)
                .await
                .map_err(|e| AppError::Http(format!("read file {}: {e}", path)))?;
            builder = builder.body(bytes);
        }
        BruBodyWire::Form { fields } => {
            builder = builder.form(&fields);
        }
        BruBodyWire::Multipart { fields } => {
            let mut form = reqwest::multipart::Form::new();
            for f in fields {
                if f.is_file {
                    let bytes = tokio::fs::read(&f.value)
                        .await
                        .map_err(|e| AppError::Http(format!("read file {}: {e}", f.value)))?;
                    let filename = std::path::Path::new(&f.value)
                        .file_name()
                        .and_then(|s| s.to_str())
                        .unwrap_or("file")
                        .to_string();
                    form = form.part(f.name, reqwest::multipart::Part::bytes(bytes).file_name(filename));
                } else {
                    form = form.text(f.name, f.value);
                }
            }
            builder = builder.multipart(form);
        }
    }

    builder = builder.headers(headers);
    if req.timeout_ms > 0 {
        builder = builder.timeout(Duration::from_millis(req.timeout_ms));
    }

    let started = Instant::now();
    let resp = builder.send().await.map_err(|e| AppError::Http(e.to_string()))?;

    let status = resp.status();
    let status_text = status.canonical_reason().unwrap_or("").to_string();
    let resp_headers: Vec<(String, String)> = resp
        .headers()
        .iter()
        .map(|(k, v)| (k.as_str().to_string(), v.to_str().unwrap_or("").to_string()))
        .collect();

    let bytes = resp.bytes().await.map_err(|e| AppError::Http(e.to_string()))?;
    let size_bytes = bytes.len() as u64;
    let is_binary = std::str::from_utf8(&bytes).is_err();
    let body = String::from_utf8_lossy(&bytes).into_owned();

    Ok(BruSendResponse {
        status: status.as_u16(),
        status_text,
        headers: resp_headers,
        body,
        is_binary,
        size_bytes,
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

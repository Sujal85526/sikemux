use std::path::Path;
use std::sync::OnceLock;
use std::time::Duration;

use futures::StreamExt;
use reqwest::{Client, Method, Response};
use serde_json::Value;

use crate::config::{self, Credentials};
use crate::error::{SignozError, SignozResult};

const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;

fn http() -> SignozResult<&'static Client> {
    static CLIENT: OnceLock<Option<Client>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            Client::builder()
                .pool_idle_timeout(Duration::from_secs(25))
                .timeout(Duration::from_secs(30))
                .redirect(reqwest::redirect::Policy::none())
                .user_agent("sikemux-signoz/0.1")
                .build()
                .ok()
        })
        .as_ref()
        .ok_or_else(|| SignozError::Transport("could not start the HTTP client".into()))
}

pub async fn credentials(data_dir: &Path) -> SignozResult<Credentials> {
    let data_dir = data_dir.to_path_buf();
    tokio::task::spawn_blocking(move || config::credentials(&data_dir))
        .await
        .map_err(|error| SignozError::Keychain(error.to_string()))?
}

async fn read_limited(response: Response) -> SignozResult<Vec<u8>> {
    if response
        .content_length()
        .is_some_and(|size| size > MAX_RESPONSE_BYTES as u64)
    {
        return Err(SignozError::Response(
            "more than 16 MiB came back; narrow the query".into(),
        ));
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err(SignozError::Response(
                "more than 16 MiB came back; narrow the query".into(),
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn error_message(body: &Value) -> Option<String> {
    let error = body.get("error")?;
    error
        .get("message")
        .and_then(Value::as_str)
        .or_else(|| error.as_str())
        .map(str::to_string)
}

pub async fn request(
    credentials: &Credentials,
    method: Method,
    path: &str,
    body: Option<&Value>,
) -> SignozResult<Value> {
    let mut request = http()?
        .request(method, format!("{}{path}", credentials.url))
        .header("SIGNOZ-API-KEY", &credentials.api_key)
        .header("Accept", "application/json");
    if let Some(body) = body {
        request = request.json(body);
    }
    let response = request.send().await?;
    let status = response.status();
    let bytes = read_limited(response).await?;
    let parsed: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    if status.as_u16() == 401 || status.as_u16() == 403 {
        config::forget_cached_key();
    }
    if !status.is_success() {
        let message = error_message(&parsed)
            .unwrap_or_else(|| String::from_utf8_lossy(&bytes).chars().take(400).collect());
        return Err(SignozError::Http {
            status: status.as_u16(),
            message,
        });
    }
    if parsed
        .get("status")
        .and_then(Value::as_str)
        .is_some_and(|value| value != "success")
    {
        return Err(SignozError::Response(
            error_message(&parsed).unwrap_or_else(|| "the query failed".into()),
        ));
    }
    Ok(parsed)
}

/// The rows and columns of the one query in `query`, which is always named "A".
pub async fn query_range(credentials: &Credentials, query: &Value) -> SignozResult<Value> {
    let body = request(
        credentials,
        Method::POST,
        "/api/v5/query_range",
        Some(query),
    )
    .await?;
    body.pointer("/data/data/results/0")
        .cloned()
        .ok_or_else(|| SignozError::Response("no results in the answer".into()))
}

// Shared HTTP plumbing. One process-wide reqwest::Client keeps connections
// warm across the matrix dashboard's parallel fan-out; auto-refresh kicks in
// transparently on a 401/403 the same way the bash CLI's `rd_api` does.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use futures::StreamExt;
use reqwest::{Client, Method, Response};
use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::error::{RundeckError, RundeckResult};

use crate::config;

pub const API_VERSION: u32 = 41;
const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;

fn http() -> RundeckResult<&'static Client> {
    static C: OnceLock<Option<Client>> = OnceLock::new();
    C.get_or_init(|| {
        Client::builder()
            // Servers behind corporate proxies sometimes drop idle keep-alive
            // after ~30s. 25s pool idle keeps reuse safe.
            .pool_idle_timeout(Duration::from_secs(25))
            .timeout(Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::none())
            .user_agent("sikemux-rundeck/0.1")
            .build()
            .ok()
    })
    .as_ref()
    .ok_or_else(|| RundeckError::Api("could not start the HTTP client".into()))
}

/// A warm client per pinned target. Building one per request threw away the
/// connection pool, so a private-HTTP install paid a fresh handshake on every
/// call of the dashboard's fan-out. The key is the pinned address set, so a
/// different DNS answer never reuses the old client.
fn pinned_http(transport: &config::ValidatedTransport) -> RundeckResult<Client> {
    const MAX_CACHED_CLIENTS: usize = 8;
    static CACHE: OnceLock<Mutex<HashMap<String, Client>>> = OnceLock::new();

    let key = transport.pin_key();
    let mut cache = CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(client) = cache.get(&key) {
        return Ok(client.clone());
    }

    let client = transport
        .pin_dns(Client::builder())
        .pool_idle_timeout(Duration::from_secs(25))
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("sikemux-rundeck/0.1")
        .build()?;
    if cache.len() >= MAX_CACHED_CLIENTS {
        cache.clear();
    }
    cache.insert(key, client.clone());
    Ok(client)
}

fn api_url(base: &str, endpoint: &str) -> String {
    let trimmed = base.trim_end_matches('/');
    format!("{trimmed}/api/{API_VERSION}{endpoint}")
}

async fn send_with_token(
    method: Method,
    endpoint: &str,
    body: Option<&serde_json::Value>,
    query: &[(&str, String)],
    token_override: Option<&str>,
) -> RundeckResult<Response> {
    // Cache may be empty on cold boot (status hasn't run yet) or stale
    // after a `rnd login` from the CLI. Refresh on every request so the
    // first branchesMatrix call from the TopBar's DeployChip doesn't race
    // ahead of the pane's status check and falsely report "not configured".
    let cfg = config::refresh_from_disk()
        .await
        .unwrap_or_else(|_| config::RundeckConfig::default());
    if cfg.url.is_empty() {
        return Err(RundeckError::Unconfigured);
    }
    let transport = config::validate_transport(&cfg.url, cfg.allow_insecure_private_http).await?;
    let token = token_override.unwrap_or(&cfg.token);
    if token.is_empty() {
        return Err(RundeckError::Unconfigured);
    }

    // For acknowledged private HTTP, bind this client to the exact private
    // addresses that passed validation. This closes the re-resolution gap a
    // DNS rebinding response could otherwise exploit between policy and send.
    let private_client = if transport.pins_private_dns() {
        Some(pinned_http(&transport)?)
    } else {
        None
    };
    let client = match private_client.as_ref() {
        Some(client) => client,
        None => http()?,
    };
    let mut req = client
        .request(method, api_url(&cfg.url, endpoint))
        .header("X-Rundeck-Auth-Token", token)
        .header("Accept", "application/json");
    if !query.is_empty() {
        req = req.query(query);
    }
    if let Some(b) = body {
        req = req.json(b);
    }
    let resp = req.send().await?;
    Ok(resp)
}

/// Public GET helper with automatic re-auth on 401/403.
pub async fn get_json<T: DeserializeOwned>(
    endpoint: &str,
    query: &[(&str, String)],
) -> RundeckResult<T> {
    request_json(Method::GET, endpoint, None, query).await
}

/// Public POST (JSON body, JSON response) with automatic re-auth.
pub async fn post_json<B: Serialize, T: DeserializeOwned>(
    endpoint: &str,
    body: &B,
) -> RundeckResult<T> {
    let val = serde_json::to_value(body).map_err(RundeckError::Json)?;
    request_json(Method::POST, endpoint, Some(&val), &[]).await
}

/// POST with no body, expecting JSON response.
pub async fn post_empty_json<T: DeserializeOwned>(endpoint: &str) -> RundeckResult<T> {
    request_json(Method::POST, endpoint, None, &[]).await
}

async fn request_json<T: DeserializeOwned>(
    method: Method,
    endpoint: &str,
    body: Option<&serde_json::Value>,
    query: &[(&str, String)],
) -> RundeckResult<T> {
    let resp = send_with_token(method, endpoint, body, query, None).await?;
    decode(resp).await
}

async fn decode<T: DeserializeOwned>(resp: Response) -> RundeckResult<T> {
    let status = resp.status();
    if resp
        .content_length()
        .is_some_and(|size| size > MAX_RESPONSE_BYTES as u64)
    {
        return Err(RundeckError::Api("response exceeds 16 MiB limit".into()));
    }
    let mut stream = resp.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err(RundeckError::Api("response exceeds 16 MiB limit".into()));
        }
        bytes.extend_from_slice(&chunk);
    }
    if !status.is_success() {
        let body = String::from_utf8_lossy(&bytes).into_owned();
        let message = extract_message(&body).unwrap_or_else(|| {
            if body.is_empty() {
                status.canonical_reason().unwrap_or("error").to_string()
            } else {
                body
            }
        });
        return Err(RundeckError::Http {
            status: status.as_u16(),
            message,
        });
    }
    if bytes.is_empty() {
        // Caller deserialising into () should still succeed.
        return serde_json::from_slice::<T>(b"null").map_err(RundeckError::Json);
    }
    serde_json::from_slice::<T>(&bytes).map_err(RundeckError::Json)
}

fn extract_message(body: &str) -> Option<String> {
    let v = serde_json::from_str::<serde_json::Value>(body).ok()?;
    for k in ["message", "error", "errorMessage"] {
        if let Some(s) = v.get(k).and_then(|x| x.as_str()) {
            return Some(s.to_string());
        }
    }
    None
}

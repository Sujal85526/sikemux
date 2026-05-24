// Shared HTTP plumbing. One process-wide reqwest::Client keeps connections
// warm across the matrix dashboard's parallel fan-out; auto-refresh kicks in
// transparently on a 401/403 the same way the bash CLI's `rd_api` does.

use std::sync::OnceLock;
use std::time::Duration;

use reqwest::{Client, Method, Response, StatusCode};
use serde::de::DeserializeOwned;
use serde::Serialize;
use tokio::sync::Mutex;

use crate::error::{AppError, AppResult};

use super::auth::reauth_with_stored_creds;
use super::config;

pub const API_VERSION: u32 = 41;

pub fn http() -> &'static Client {
    static C: OnceLock<Client> = OnceLock::new();
    C.get_or_init(|| {
        Client::builder()
            // Servers behind corporate proxies sometimes drop idle keep-alive
            // after ~30s. 25s pool idle keeps reuse safe.
            .pool_idle_timeout(Duration::from_secs(25))
            .timeout(Duration::from_secs(30))
            .cookie_store(true)
            .user_agent("sikemux-rundeck/0.1")
            .build()
            .expect("build reqwest client")
    })
}

/// Serialise re-auth attempts so a burst of concurrent 401s doesn't trigger
/// N parallel j_security_check round trips against the same Rundeck.
fn reauth_lock() -> &'static Mutex<()> {
    static L: OnceLock<Mutex<()>> = OnceLock::new();
    L.get_or_init(|| Mutex::new(()))
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
) -> AppResult<Response> {
    let cfg = config::get().await;
    if cfg.url.is_empty() {
        return Err(AppError::RundeckUnconfigured);
    }
    let token = token_override.unwrap_or(&cfg.token);
    if token.is_empty() {
        return Err(AppError::RundeckUnconfigured);
    }

    let mut req = http()
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
) -> AppResult<T> {
    request_json(Method::GET, endpoint, None, query).await
}

/// Public POST (JSON body, JSON response) with automatic re-auth.
pub async fn post_json<B: Serialize, T: DeserializeOwned>(
    endpoint: &str,
    body: &B,
) -> AppResult<T> {
    let val = serde_json::to_value(body).map_err(AppError::Json)?;
    request_json(Method::POST, endpoint, Some(&val), &[]).await
}

/// POST with no body, expecting JSON response.
pub async fn post_empty_json<T: DeserializeOwned>(endpoint: &str) -> AppResult<T> {
    request_json(Method::POST, endpoint, None, &[]).await
}

async fn request_json<T: DeserializeOwned>(
    method: Method,
    endpoint: &str,
    body: Option<&serde_json::Value>,
    query: &[(&str, String)],
) -> AppResult<T> {
    let resp = send_with_token(method.clone(), endpoint, body, query, None).await?;
    let status = resp.status();
    if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
        // Drain body, then attempt one silent re-auth + retry.
        let _ = resp.bytes().await;
        let new_token = {
            let _guard = reauth_lock().lock().await;
            // Another request may have just refreshed the token — peek first.
            let cur = config::refresh_from_disk().await?;
            if !cur.token.is_empty() {
                match send_with_token(method.clone(), endpoint, body, query, Some(&cur.token))
                    .await
                {
                    Ok(retry) if retry.status() != StatusCode::UNAUTHORIZED
                        && retry.status() != StatusCode::FORBIDDEN =>
                    {
                        return decode(retry).await;
                    }
                    _ => {}
                }
            }
            reauth_with_stored_creds().await?
        };
        let retry =
            send_with_token(method, endpoint, body, query, Some(&new_token)).await?;
        return decode(retry).await;
    }
    decode(resp).await
}

async fn decode<T: DeserializeOwned>(resp: Response) -> AppResult<T> {
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        let message = extract_message(&body).unwrap_or_else(|| {
            if body.is_empty() {
                status.canonical_reason().unwrap_or("error").to_string()
            } else {
                body
            }
        });
        return Err(AppError::RundeckHttp {
            status: status.as_u16(),
            message,
        });
    }
    let bytes = resp.bytes().await?;
    if bytes.is_empty() {
        // Caller deserialising into () should still succeed.
        return serde_json::from_slice::<T>(b"null").map_err(AppError::Json);
    }
    serde_json::from_slice::<T>(&bytes).map_err(AppError::Json)
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

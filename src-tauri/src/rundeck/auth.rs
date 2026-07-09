// Two-step auth: POST to /j_security_check with a form payload to get a
// session cookie, then POST /api/{v}/tokens/{user} to mint a long-lived API
// token. Cookie state is provided per-call by a fresh cookie jar so we don't
// accidentally leak login sessions across requests — every interactive login
// is its own fresh flow.

use std::sync::Arc;
use std::time::Duration;

use futures::StreamExt;
use reqwest::{Client, Response};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

use super::client::API_VERSION;
use super::config::{self, RundeckConfig};

const MAX_AUTH_RESPONSE_BYTES: usize = 1024 * 1024;

async fn response_text_limited(resp: Response) -> AppResult<String> {
    if resp
        .content_length()
        .is_some_and(|size| size > MAX_AUTH_RESPONSE_BYTES as u64)
    {
        return Err(AppError::RundeckAuth(
            "authentication response exceeds 1 MiB limit".into(),
        ));
    }
    let mut stream = resp.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| AppError::RundeckAuth(e.to_string()))?;
        if bytes.len() + chunk.len() > MAX_AUTH_RESPONSE_BYTES {
            return Err(AppError::RundeckAuth(
                "authentication response exceeds 1 MiB limit".into(),
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    String::from_utf8(bytes)
        .map_err(|_| AppError::RundeckAuth("authentication response is not UTF-8".into()))
}

#[derive(Serialize, Deserialize, Clone)]
pub struct LoginRequest {
    pub url: String,
    pub user: String,
    pub password: String,
}

#[derive(Serialize, Clone)]
pub struct LoginResult {
    pub url: String,
    pub user: String,
    pub token_set: bool,
    pub rundeck_version: Option<String>,
}

fn short_hostname() -> String {
    use std::process::Command;
    Command::new("hostname")
        .arg("-s")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown".into())
}

fn fresh_session_client() -> AppResult<Client> {
    Ok(Client::builder()
        .cookie_provider(Arc::new(reqwest::cookie::Jar::default()))
        .timeout(Duration::from_secs(20))
        .user_agent("sikemux-rundeck-auth/0.1")
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 {
                return attempt.error("too many redirects");
            }
            let next = attempt.url();
            let Some(first) = attempt.previous().first() else {
                return attempt.stop();
            };
            if first.scheme() != next.scheme()
                || first.host_str() != next.host_str()
                || first.port_or_known_default() != next.port_or_known_default()
            {
                return attempt.error("refusing cross-origin credential redirect");
            }
            attempt.follow()
        }))
        .build()?)
}

/// Drive the j_security_check → /tokens/{user} flow. Returns the bearer token.
pub async fn perform_login(req: &LoginRequest) -> AppResult<String> {
    let url = req.url.trim_end_matches('/');
    config::validate_base_url(url)?;
    let client = fresh_session_client()?;

    // Step 1: session login
    let form = [
        ("j_username", req.user.as_str()),
        ("j_password", req.password.as_str()),
    ];
    let resp = client
        .post(format!("{url}/j_security_check"))
        .form(&form)
        .send()
        .await
        .map_err(|e| AppError::RundeckAuth(format!("login request: {e}")))?;

    let final_url = resp.url().to_string();
    if final_url.contains("/user/error") || final_url.contains("/user/login") {
        return Err(AppError::RundeckAuth("invalid username or password".into()));
    }
    let status = resp.status();
    if !status.is_success() && !status.is_redirection() {
        return Err(AppError::RundeckAuth(format!(
            "login returned http {}",
            status.as_u16()
        )));
    }

    // Step 2: discover roles (best-effort) then mint token
    let roles: String = (async {
        let resp = client
            .get(format!("{url}/api/{API_VERSION}/user/roles"))
            .header("Accept", "application/json")
            .send()
            .await
            .ok()?;
        if !resp.status().is_success() {
            return None;
        }
        let text = response_text_limited(resp).await.ok()?;
        let v: serde_json::Value = serde_json::from_str(&text).ok()?;
        v.get("roles").and_then(|r| r.as_array()).map(|arr| {
            arr.iter()
                .filter_map(|s| s.as_str())
                .collect::<Vec<_>>()
                .join(",")
        })
    })
    .await
    .unwrap_or_else(|| req.user.clone());

    let token_name = format!("sikemux-{}", short_hostname());

    let payload = serde_json::json!({
        "user": req.user,
        "roles": roles,
        "duration": "0",
        "name": token_name,
    });

    let token_resp = client
        .post(format!("{url}/api/{API_VERSION}/tokens/{}", req.user))
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .json(&payload)
        .send()
        .await
        .map_err(|e| AppError::RundeckAuth(format!("token request: {e}")))?;

    let status = token_resp.status();
    let body = response_text_limited(token_resp).await?;
    if !status.is_success() {
        let msg = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| v.get("message").and_then(|s| s.as_str()).map(String::from))
            .unwrap_or(body);
        return Err(AppError::RundeckAuth(format!(
            "could not mint token (http {}): {}",
            status.as_u16(),
            msg
        )));
    }
    let parsed: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| AppError::RundeckAuth(e.to_string()))?;
    let token = parsed
        .get("token")
        .and_then(|t| t.as_str())
        .ok_or_else(|| AppError::RundeckAuth("token field missing in response".into()))?
        .to_string();
    Ok(token)
}

// ---- Tauri commands ------------------------------------------------------

#[derive(Serialize, Clone)]
pub struct RundeckStatus {
    pub configured: bool,
    pub url: String,
    pub user: String,
    pub token_present: bool,
    pub rundeck_version: Option<String>,
    pub ok: bool,
    pub auth_failed: bool,
    pub message: Option<String>,
}

fn is_auth_failure(e: &AppError) -> bool {
    matches!(
        e,
        AppError::RundeckAuth(_)
            | AppError::RundeckUnconfigured
            | AppError::RundeckHttp {
                status: 401 | 403,
                ..
            }
    )
}

#[tauri::command]
pub async fn rnd_status() -> RundeckStatus {
    // Always reload from disk on status checks — the CLI may have written
    // a new token since boot.
    let cfg = config::refresh_from_disk()
        .await
        .unwrap_or_else(|_| RundeckConfig::default());

    if !cfg.is_configured() {
        return RundeckStatus {
            configured: false,
            url: cfg.url,
            user: cfg.user,
            token_present: !cfg.token.is_empty(),
            rundeck_version: None,
            ok: false,
            auth_failed: false,
            message: None,
        };
    }

    let info: AppResult<serde_json::Value> = super::client::get_json("/system/info", &[]).await;
    match info {
        Ok(v) => RundeckStatus {
            configured: true,
            url: cfg.url,
            user: cfg.user,
            token_present: true,
            rundeck_version: v
                .pointer("/system/rundeck/version")
                .and_then(|s| s.as_str())
                .map(String::from),
            ok: true,
            auth_failed: false,
            message: None,
        },
        Err(e) => RundeckStatus {
            configured: true,
            url: cfg.url,
            user: cfg.user,
            token_present: true,
            rundeck_version: None,
            ok: false,
            auth_failed: is_auth_failure(&e),
            message: Some(e.to_string()),
        },
    }
}

#[tauri::command]
pub async fn rnd_login(req: LoginRequest) -> AppResult<LoginResult> {
    let url = req.url.trim_end_matches('/').to_string();
    let token = perform_login(&LoginRequest {
        url: url.clone(),
        user: req.user.clone(),
        password: req.password.clone(),
    })
    .await?;
    let cfg = RundeckConfig {
        url: url.clone(),
        user: req.user.clone(),
        password: String::new(),
        token: token.clone(),
    };
    config::save(cfg).await?;

    // Verify against /system/info so the user gets immediate feedback.
    let version: Option<String> = super::client::get_json::<serde_json::Value>("/system/info", &[])
        .await
        .ok()
        .and_then(|v| {
            v.pointer("/system/rundeck/version")
                .and_then(|s| s.as_str())
                .map(String::from)
        });

    Ok(LoginResult {
        url,
        user: req.user,
        token_set: true,
        rundeck_version: version,
    })
}

#[tauri::command]
pub async fn rnd_logout() -> AppResult<()> {
    // Clear in-memory and on-disk auth state without wiping URL — user often
    // just wants to switch accounts on the same Rundeck.
    let mut cfg = config::get().await;
    cfg.password.clear();
    cfg.token.clear();
    config::save(cfg).await
}

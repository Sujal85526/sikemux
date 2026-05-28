// Two-step auth: POST to /j_security_check with a form payload to get a
// session cookie, then POST /api/{v}/tokens/{user} to mint a long-lived API
// token. Cookie state is provided per-call by a fresh cookie jar so we don't
// accidentally leak login sessions across requests — every interactive login
// is its own fresh flow.

use std::sync::Arc;
use std::time::Duration;

use reqwest::Client;
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

use super::client::API_VERSION;
use super::config::{self, RundeckConfig};

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
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()?)
}

/// Drive the j_security_check → /tokens/{user} flow. Returns the bearer token.
pub async fn perform_login(req: &LoginRequest) -> AppResult<String> {
    let url = req.url.trim_end_matches('/');
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
        let v: serde_json::Value = resp.json().await.ok()?;
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
    let body = token_resp.text().await.unwrap_or_default();
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

/// Used by the auto-refresh path in client.rs. Requires stored credentials.
pub async fn reauth_with_stored_creds() -> AppResult<String> {
    let cfg = config::refresh_from_disk().await?;
    if cfg.user.is_empty() || cfg.password.is_empty() {
        return Err(AppError::RundeckAuth(
            "stored credentials missing; re-login required".into(),
        ));
    }
    let token = perform_login(&LoginRequest {
        url: cfg.url.clone(),
        user: cfg.user.clone(),
        password: cfg.password.clone(),
    })
    .await?;
    config::update_token(token.clone()).await?;
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
    pub message: Option<String>,
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
            message: None,
        },
        Err(e) => RundeckStatus {
            configured: true,
            url: cfg.url,
            user: cfg.user,
            token_present: true,
            rundeck_version: None,
            ok: false,
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
        password: req.password.clone(),
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

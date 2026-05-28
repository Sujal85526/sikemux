// Profile discovery and identity/SSO-login surface.
//
//   aws_profiles          — parse ~/.aws/{config,credentials}, classify
//   aws_caller_identity   — `sts get-caller-identity`, 60s per-process cache
//   aws_sso_login         — `aws sso login` (spawn-and-wait)

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::error::AppResult;

use super::common::{classify_cli_err, run_aws_cli_async};

// ============================================================
// profile discovery
// ============================================================

#[derive(Serialize, Clone, Copy, Debug)]
#[serde(rename_all = "snake_case")]
pub enum AwsKind {
    Sso,
    Role,
    CredentialProcess,
    Credentials,
}

#[derive(Serialize, Clone)]
pub struct AwsProfile {
    name: String,
    region: Option<String>,
    sso_start_url: Option<String>,
    sso_region: Option<String>,
    sso_account_id: Option<String>,
    sso_role_name: Option<String>,
    kind: AwsKind,
}

fn config_path() -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    Some(PathBuf::from(home).join(".aws/config"))
}

fn credentials_path() -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    Some(PathBuf::from(home).join(".aws/credentials"))
}

/// Parse an INI-style AWS config. Supports `[profile X]`, `[default]`, and
/// `[sso-session Y]`. Returns `(profile_blocks, sso_session_blocks)`.
fn parse_ini(
    content: &str,
) -> (
    HashMap<String, HashMap<String, String>>,
    HashMap<String, HashMap<String, String>>,
) {
    let mut profiles: HashMap<String, HashMap<String, String>> = HashMap::new();
    let mut sessions: HashMap<String, HashMap<String, String>> = HashMap::new();
    let mut current: Option<(bool, String)> = None;

    for raw in content.lines() {
        let line = raw
            .split(|c| c == '#' || c == ';')
            .next()
            .unwrap_or("")
            .trim();
        if line.is_empty() {
            continue;
        }
        if let Some(rest) = line.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
            let body = rest.trim();
            if let Some(name) = body.strip_prefix("profile ") {
                current = Some((false, name.trim().to_string()));
            } else if let Some(name) = body.strip_prefix("sso-session ") {
                current = Some((true, name.trim().to_string()));
            } else if body == "default" {
                current = Some((false, "default".to_string()));
            } else {
                current = None;
            }
            continue;
        }
        let Some((ref is_session, ref key)) = current else {
            continue;
        };
        let Some((k, v)) = line.split_once('=') else {
            continue;
        };
        let k = k.trim().to_string();
        let v = v.trim().to_string();
        let bucket = if *is_session {
            sessions.entry(key.clone()).or_default()
        } else {
            profiles.entry(key.clone()).or_default()
        };
        bucket.insert(k, v);
    }
    (profiles, sessions)
}

fn classify(p: &HashMap<String, String>) -> AwsKind {
    if p.contains_key("sso_session") || p.contains_key("sso_start_url") {
        AwsKind::Sso
    } else if p.contains_key("role_arn") {
        AwsKind::Role
    } else if p.contains_key("credential_process") {
        AwsKind::CredentialProcess
    } else {
        AwsKind::Credentials
    }
}

#[tauri::command]
pub fn aws_profiles() -> Vec<AwsProfile> {
    let mut out: Vec<AwsProfile> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    if let Some(path) = config_path() {
        if let Ok(content) = fs::read_to_string(&path) {
            let (profiles, sessions) = parse_ini(&content);
            for (name, p) in profiles {
                let session = p.get("sso_session").and_then(|s| sessions.get(s)).cloned();
                let pick = |key: &str| -> Option<String> {
                    p.get(key)
                        .cloned()
                        .or_else(|| session.as_ref().and_then(|s| s.get(key).cloned()))
                };
                let entry = AwsProfile {
                    region: p.get("region").cloned(),
                    sso_start_url: pick("sso_start_url"),
                    sso_region: pick("sso_region"),
                    sso_account_id: p.get("sso_account_id").cloned(),
                    sso_role_name: p.get("sso_role_name").cloned(),
                    kind: classify(&p),
                    name: name.clone(),
                };
                seen.insert(name);
                out.push(entry);
            }
        }
    }

    if let Some(path) = credentials_path() {
        if let Ok(content) = fs::read_to_string(&path) {
            let (creds, _) = parse_ini(&content);
            for (name, _p) in creds {
                if seen.insert(name.clone()) {
                    out.push(AwsProfile {
                        name,
                        region: None,
                        sso_start_url: None,
                        sso_region: None,
                        sso_account_id: None,
                        sso_role_name: None,
                        kind: AwsKind::Credentials,
                    });
                }
            }
        }
    }

    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

// ============================================================
// caller identity (cached)
// ============================================================

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AwsStatus {
    Authed,
    Expired,
    NoCredentials,
    Error,
    CliMissing,
}

#[derive(Serialize, Clone)]
pub struct AwsIdentity {
    arn: Option<String>,
    account: Option<String>,
    user_id: Option<String>,
    status: AwsStatus,
    message: Option<String>,
}

fn id_cache() -> &'static Mutex<HashMap<String, (Instant, AwsIdentity)>> {
    static C: OnceLock<Mutex<HashMap<String, (Instant, AwsIdentity)>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

const ID_TTL: Duration = Duration::from_secs(60);

#[tauri::command]
pub async fn aws_caller_identity(profile: String, force: bool) -> AwsIdentity {
    if !force {
        if let Some(cached) = id_cache()
            .lock()
            .ok()
            .and_then(|c| c.get(&profile).cloned())
        {
            if cached.0.elapsed() < ID_TTL {
                return cached.1;
            }
        }
    }

    let id = match run_aws_cli_async(
        &["sts", "get-caller-identity", "--output", "json"],
        Some(&profile),
    )
    .await
    {
        Err(crate::error::AppError::AwsCliMissing(msg)) => AwsIdentity {
            arn: None,
            account: None,
            user_id: None,
            status: AwsStatus::CliMissing,
            message: Some(msg),
        },
        Err(e) => AwsIdentity {
            arn: None,
            account: None,
            user_id: None,
            status: AwsStatus::Error,
            message: Some(e.to_string()),
        },
        Ok((true, stdout, _)) => {
            let mut arn = None;
            let mut account = None;
            let mut user_id = None;
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&stdout) {
                arn = v.get("Arn").and_then(|s| s.as_str()).map(String::from);
                account = v.get("Account").and_then(|s| s.as_str()).map(String::from);
                user_id = v.get("UserId").and_then(|s| s.as_str()).map(String::from);
            }
            AwsIdentity {
                arn,
                account,
                user_id,
                status: AwsStatus::Authed,
                message: None,
            }
        }
        Ok((false, _, stderr)) => {
            let status = match classify_cli_err(&stderr) {
                crate::error::AppError::AwsTokenExpired => AwsStatus::Expired,
                crate::error::AppError::AwsNoCredentials => AwsStatus::NoCredentials,
                _ => AwsStatus::Error,
            };
            AwsIdentity {
                arn: None,
                account: None,
                user_id: None,
                status,
                message: Some(stderr.trim().to_string()),
            }
        }
    };

    if let Ok(mut cache) = id_cache().lock() {
        cache.insert(profile, (Instant::now(), id.clone()));
    }
    id
}

// ============================================================
// SSO login
// ============================================================

#[derive(Serialize, Clone)]
pub struct AwsLoginResult {
    success: bool,
    stdout: String,
    stderr: String,
}

#[tauri::command]
pub async fn aws_sso_login(profile: String) -> AppResult<AwsLoginResult> {
    let r = run_aws_cli_async(&["sso", "login"], Some(&profile)).await;
    // Drop the cached "expired" identity so the next aws_caller_identity
    // call doesn't lie about state.
    if let Ok(mut cache) = id_cache().lock() {
        cache.remove(&profile);
    }
    match r {
        Ok((ok, out, err)) => Ok(AwsLoginResult {
            success: ok,
            stdout: out,
            stderr: err,
        }),
        Err(e) => Ok(AwsLoginResult {
            success: false,
            stdout: String::new(),
            stderr: e.to_string(),
        }),
    }
}

// Signing in, signing out, and saying who the app is talking to GitHub as.
// A token typed here is saved in the Keychain; one already in the environment
// or held by the `gh` CLI is used where it is and never copied.

use std::path::Path;

use reqwest::Method;
use serde::{Deserialize, Serialize};

use crate::client::{self, Session};
use crate::config::{self, ActionsConfig, TokenSource};
use crate::error::{ActionsError, ActionsResult};

#[derive(Deserialize)]
struct Viewer {
    login: String,
}

/// Who a token belongs to, and what it is allowed to do. Fine-grained tokens
/// list no scopes at all, which is why an empty list is not a problem.
pub struct Identity {
    pub login: String,
    pub scopes: Vec<String>,
}

pub async fn identify(session: &Session) -> ActionsResult<Identity> {
    let (status, headers, bytes) = client::send(session, Method::GET, "/user", &[], None).await?;
    if !status.is_success() {
        return Err(client::classify(status, &headers, &bytes));
    }
    let viewer: Viewer = serde_json::from_slice(&bytes)?;
    let scopes = headers
        .get("x-oauth-scopes")
        .and_then(|value| value.to_str().ok())
        .map(|value| {
            value
                .split(',')
                .map(str::trim)
                .filter(|scope| !scope.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    Ok(Identity {
        login: viewer.login,
        scopes,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub configured: bool,
    pub host: String,
    pub login: String,
    pub token_source: Option<TokenSource>,
    pub scopes: Vec<String>,
    /// Whether the token may read and start workflow runs, not only read code.
    pub can_write_workflows: bool,
    pub ok: bool,
    pub auth_failed: bool,
    pub message: Option<String>,
}

/// A classic token needs the `workflow` scope to re-run or dispatch. A
/// fine-grained one lists no scopes, so it is taken at its word and the API
/// says no later if it may not.
fn can_write(scopes: &[String]) -> bool {
    scopes.is_empty() || scopes.iter().any(|scope| scope == "workflow")
}

pub async fn status(data_dir: &Path) -> Status {
    let config = config::load(data_dir);
    let base = |ok,
                auth_failed,
                login: String,
                token_source: Option<TokenSource>,
                scopes: Vec<String>,
                message| Status {
        configured: token_source.is_some(),
        host: config.host.clone(),
        can_write_workflows: ok && can_write(&scopes),
        login,
        token_source,
        scopes,
        ok,
        auth_failed,
        message,
    };
    let session = match Session::current(data_dir) {
        Ok(session) => session,
        Err(_) => return base(false, false, String::new(), None, Vec::new(), None),
    };
    let source = session.source;
    match identify(&session).await {
        Ok(identity) => base(
            true,
            false,
            identity.login,
            Some(source),
            identity.scopes,
            None,
        ),
        Err(error) => {
            let auth_failed = matches!(
                error,
                ActionsError::Auth(_) | ActionsError::Unconfigured | ActionsError::Forbidden(_)
            );
            base(
                false,
                auth_failed,
                config.login.clone(),
                Some(source),
                Vec::new(),
                Some(error.to_string()),
            )
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignIn {
    pub host: Option<String>,
    /// Left out when the token already in the environment, or held by `gh`, is the one to use.
    pub token: Option<String>,
}

pub async fn sign_in(data_dir: &Path, input: SignIn) -> ActionsResult<()> {
    let host = match input.host.as_deref() {
        Some(host) => config::validate_host(host)?,
        None => config::load(data_dir).host,
    };
    let token = input.token.map(|token| token.trim().to_string());
    let (token, owns_token) = match token.filter(|token| !token.is_empty()) {
        Some(token) => (token, true),
        None => {
            let existing = config::env_token()
                .or_else(|| config::gh_cli_token(&host))
                .ok_or_else(|| {
                    ActionsError::Auth(
                        "no token was given, and none is in the environment or the gh CLI".into(),
                    )
                })?;
            (existing, false)
        }
    };
    let probe = Session {
        host: host.clone(),
        token: token.clone(),
        source: if owns_token {
            TokenSource::Keychain
        } else {
            TokenSource::Environment
        },
    };
    let identity = identify(&probe).await?;
    if owns_token {
        config::keychain_write(&host, &token)?;
    }
    config::save(
        data_dir,
        &ActionsConfig {
            host,
            login: identity.login,
            owns_token,
        },
    )
}

/// Only a token Sikemux saved is deleted. One the shell or `gh` provides is
/// left where it is, and simply stops being used here.
pub async fn sign_out(data_dir: &Path) -> ActionsResult<()> {
    let config = config::load(data_dir);
    if config.owns_token {
        config::keychain_delete(&config.host)?;
    }
    config::forget(data_dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_classic_token_needs_the_workflow_scope_and_a_fine_grained_one_lists_none() {
        assert!(can_write(&[]));
        assert!(can_write(&["repo".into(), "workflow".into()]));
        assert!(!can_write(&["repo".into()]));
        assert!(!can_write(&["read:org".into()]));
    }
}

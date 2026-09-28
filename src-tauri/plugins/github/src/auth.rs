// Signing in, signing out, and saying who the app is talking to GitHub as.
// A token typed here is saved in the Keychain; one already in the environment
// or held by the `gh` CLI is used where it is and never copied.

use std::path::Path;

use reqwest::Method;
use serde::{Deserialize, Serialize};

use crate::client::{self, Session};
use crate::config::{self, GithubConfig, TokenSource};
use crate::error::{GithubError, GithubResult};

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

pub async fn identify(session: &Session) -> GithubResult<Identity> {
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
    let session = match Session::current(data_dir).await {
        Ok(session) => session,
        // Not signed in, but a token the shell or `gh` holds can be offered.
        Err(GithubError::Unconfigured) => {
            let host = config.host.clone();
            let waiting = config::blocking(Box::new(move || Ok(config::offered_token(&host))))
                .await
                .ok()
                .flatten()
                .map(|(_, source)| source);
            let mut status = base(false, false, String::new(), waiting, Vec::new(), None);
            status.configured = false;
            return status;
        }
        // A locked or unanswering Keychain is not the same as being signed out.
        Err(error) => {
            return base(
                false,
                false,
                config.login.clone(),
                config.source,
                Vec::new(),
                Some(error.to_string()),
            )
        }
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
                GithubError::Auth(_) | GithubError::Unconfigured | GithubError::Forbidden(_)
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

pub async fn sign_in(data_dir: &Path, input: SignIn) -> GithubResult<()> {
    let before = config::load(data_dir);
    let host = match input.host.as_deref() {
        Some(host) => config::validate_host(host)?,
        None => before.host.clone(),
    };
    let token = input.token.map(|token| token.trim().to_string());
    let (token, source) = match token.filter(|token| !token.is_empty()) {
        Some(token) => (token, TokenSource::Keychain),
        None => {
            let host = host.clone();
            config::blocking(Box::new(move || Ok(config::offered_token(&host))))
                .await?
                .ok_or_else(|| {
                    GithubError::Auth(
                        "no token was given, and none is in the environment or the gh CLI".into(),
                    )
                })?
        }
    };
    let owns_token = source == TokenSource::Keychain;
    let probe = Session {
        host: host.clone(),
        token: token.clone(),
        source,
    };
    let identity = identify(&probe).await?;
    let data_dir = data_dir.to_path_buf();
    config::blocking(Box::new(move || {
        if owns_token {
            config::keychain_write(&host, &token)?;
        }
        if leaves_a_token_behind(&before, &host, owns_token) {
            config::keychain_delete(&before.host)?;
        }
        config::forget_token();
        config::save(
            &data_dir,
            &GithubConfig {
                host,
                login: identity.login,
                source: Some(source),
                owns_token,
                signed_out: false,
            },
        )
    }))
    .await
}

/// A token Sikemux saved earlier is deleted once a sign-in stops using it,
/// rather than left in the Keychain where nothing will ever clear it.
fn leaves_a_token_behind(before: &GithubConfig, host: &str, owns_token: bool) -> bool {
    before.owns_token && !(owns_token && before.host == host)
}

/// Only a token Sikemux saved is deleted. One the shell or `gh` provides is
/// left where it is, and is not used here again until somebody signs in.
pub async fn sign_out(data_dir: &Path) -> GithubResult<()> {
    let data_dir = data_dir.to_path_buf();
    config::blocking(Box::new(move || {
        config::forget_token();
        let config = config::load(&data_dir);
        if config.owns_token {
            config::keychain_delete(&config.host)?;
        }
        config::save(
            &data_dir,
            &GithubConfig {
                host: config.host,
                signed_out: true,
                ..GithubConfig::default()
            },
        )
    }))
    .await
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

    #[test]
    fn a_saved_token_goes_once_nothing_uses_it() {
        let owned = GithubConfig {
            host: "github.com".into(),
            owns_token: true,
            ..GithubConfig::default()
        };
        assert!(leaves_a_token_behind(&owned, "github.com", false));
        assert!(leaves_a_token_behind(&owned, "ghe.corp", true));
        assert!(!leaves_a_token_behind(&owned, "github.com", true));
        assert!(!leaves_a_token_behind(
            &GithubConfig::default(),
            "github.com",
            false
        ));
    }
}

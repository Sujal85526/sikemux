// Signing in, signing out, and saying who the app is talking to Bitbucket as.
// Signing in through the browser is the usual way; a pasted token is there for
// workspaces that do not allow outside apps.

use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::json;
use sikemux_plugin_api::StreamSink;

use crate::client::{self, Credential, Session};
use crate::config::{self, BitbucketConfig, Method};
use crate::error::{BitbucketError, BitbucketResult};
use crate::oauth;
use crate::repo::User;

/// Long enough to sign in to Atlassian from scratch, two-step login included.
const BROWSER_WAIT: Duration = Duration::from_secs(10 * 60);
const PIPELINE_WRITE: &str = "pipeline:write";

async fn identify(credential: &Credential) -> BitbucketResult<User> {
    let request = credential.apply(client::http()?.get(format!("{}/user", client::API)));
    let response = client::limited(request.send()).await?;
    let status = response.status();
    let (bytes, _) = client::read_body(response, 1024 * 1024, false).await?;
    if !status.is_success() {
        return Err(client::classify(status, &bytes));
    }
    Ok(serde_json::from_slice(&bytes)?)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub configured: bool,
    pub method: Option<Method>,
    pub login: String,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
    /// Whether this sign-in may start and stop pipelines, not only read them.
    pub can_write_ci: bool,
    pub ok: bool,
    pub auth_failed: bool,
    pub message: Option<String>,
    /// A build without the OAuth secret can only take a pasted token.
    pub browser_sign_in: bool,
}

/// An OAuth grant says what it allows; a pasted token is taken at its word,
/// and Bitbucket says no later if it may not.
fn can_write(session: &Session) -> bool {
    session.method == Method::Token
        || session.scopes.is_empty()
        || session.scopes.iter().any(|scope| scope == PIPELINE_WRITE)
}

pub async fn status(data_dir: &Path) -> Status {
    let config = config::load(data_dir);
    let base = |ok: bool, auth_failed: bool, message: Option<String>| Status {
        configured: config.method.is_some(),
        method: config.method,
        login: config.login.clone(),
        display_name: None,
        avatar_url: None,
        can_write_ci: false,
        ok,
        auth_failed,
        message,
        browser_sign_in: oauth::available(),
    };
    let session = match Session::current(data_dir).await {
        Ok(session) => session,
        Err(BitbucketError::Unconfigured) => return base(false, false, None),
        Err(error @ BitbucketError::Auth(_)) => return base(false, true, Some(error.to_string())),
        Err(error) => return base(false, false, Some(error.to_string())),
    };
    match identify(&session.credential).await {
        Ok(user) => Status {
            login: user.login().unwrap_or_else(|| config.login.clone()),
            display_name: user.display_name.clone(),
            avatar_url: user.avatar(),
            can_write_ci: can_write(&session),
            ..base(true, false, None)
        },
        Err(error) => {
            let auth_failed = matches!(error, BitbucketError::Auth(_));
            base(false, auth_failed, Some(error.to_string()))
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenSignIn {
    pub token: String,
    /// Given with an Atlassian API token; left out for a repository or workspace access token.
    pub email: Option<String>,
}

pub async fn sign_in_with_token(data_dir: &Path, input: TokenSignIn) -> BitbucketResult<()> {
    let token = input.token.trim().to_string();
    let email = input
        .email
        .map(|email| email.trim().to_string())
        .filter(|email| !email.is_empty());
    if token.is_empty() {
        return Err(BitbucketError::BadArg("no token was given".into()));
    }
    let credential = match &email {
        Some(email) => Credential::Basic {
            email: email.clone(),
            token: token.clone(),
        },
        None => Credential::Bearer(token.clone()),
    };
    let login = match identify(&credential).await {
        Ok(user) => user.login().unwrap_or_default(),
        // An access token belongs to a repository or workspace rather than a
        // person, and may not be allowed to say who it is.
        Err(BitbucketError::Forbidden(_)) if email.is_none() => String::new(),
        Err(error) => return Err(error),
    };
    save_sign_in(
        data_dir,
        Method::Token,
        token,
        BitbucketConfig {
            method: Some(Method::Token),
            login,
            email,
        },
    )
    .await
}

async fn save_sign_in(
    data_dir: &Path,
    method: Method,
    secret: String,
    config: BitbucketConfig,
) -> BitbucketResult<()> {
    let data_dir = data_dir.to_path_buf();
    let before = config::load(&data_dir).method;
    config::blocking(Box::new(move || {
        config::keychain_write(method, &secret)?;
        if let Some(before) = before.filter(|before| *before != method) {
            config::keychain_delete(before)?;
        }
        config::save(&data_dir, &config)
    }))
    .await?;
    client::forget().await;
    Ok(())
}

/// Opens the sign-in page through the window, which is handed the address as
/// the stream's first item, then waits for the browser to come back. Closing
/// the stream stops the wait and frees the port.
pub async fn sign_in_with_browser(data_dir: &Path, sink: &StreamSink) -> BitbucketResult<()> {
    if !oauth::available() {
        return Err(BitbucketError::Auth(
            "this build cannot sign in through the browser; use an API token instead".into(),
        ));
    }
    let callback = oauth::Callback::bind().await?;
    let state = oauth::new_state()?;
    sink.send(json!({ "url": oauth::authorize_url(&state) }))
        .map_err(|_| BitbucketError::Auth("the sign-in was closed".into()))?;
    let code = tokio::time::timeout(BROWSER_WAIT, callback.code(&state))
        .await
        .map_err(|_| BitbucketError::Auth("nobody finished signing in".into()))??;
    drop(callback);
    let tokens = oauth::exchange(&code).await?;
    let user = identify(&Credential::Bearer(tokens.access_token.clone())).await?;
    save_sign_in(
        data_dir,
        Method::Oauth,
        tokens.refresh_token.clone(),
        BitbucketConfig {
            method: Some(Method::Oauth),
            login: user.login().unwrap_or_default(),
            email: None,
        },
    )
    .await?;
    client::remember_access(&tokens).await;
    Ok(())
}

pub async fn sign_out(data_dir: &Path) -> BitbucketResult<()> {
    let data_dir = data_dir.to_path_buf();
    config::blocking(Box::new(move || {
        if let Some(method) = config::load(&data_dir).method {
            config::keychain_delete(method)?;
        }
        config::save(&data_dir, &BitbucketConfig::default())
    }))
    .await?;
    client::forget().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(method: Method, scopes: &[&str]) -> Session {
        Session {
            credential: Credential::Bearer(String::new()),
            scopes: scopes.iter().map(|scope| scope.to_string()).collect(),
            method,
        }
    }

    #[test]
    fn only_a_grant_with_pipeline_write_may_start_pipelines() {
        assert!(can_write(&session(
            Method::Oauth,
            &["pipeline:write", "pullrequest"]
        )));
        assert!(!can_write(&session(
            Method::Oauth,
            &["pipeline", "pullrequest"]
        )));
        assert!(can_write(&session(Method::Token, &[])));
    }
}

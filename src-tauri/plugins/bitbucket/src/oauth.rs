// Signing in through the browser. Bitbucket sends the browser back to this
// machine with a one-time code, which is traded for tokens. Bitbucket has no
// flow for apps that cannot keep a secret, so the client secret is compiled in,
// as every desktop Bitbucket client does.

use serde::Deserialize;
use sikemux_loopback::{redirect_uri, Callback, LoopbackError};

use crate::client;
use crate::error::{BitbucketError, BitbucketResult};

const CLIENT_ID: &str = match option_env!("BITBUCKET_OAUTH_KEY") {
    Some(key) => key,
    None => "lTLK4yE705mh4VJyRvmmB9RyIz7RlFsm",
};
const CLIENT_SECRET: Option<&str> = option_env!("BITBUCKET_OAUTH_SECRET");
/// Registered as one of the client's callbacks, so it cannot move without changing it there too.
const CALLBACK_PATH: &str = "/bitbucket/callback";
const AUTHORIZE_URL: &str = "https://bitbucket.org/site/oauth2/authorize";
const TOKEN_URL: &str = "https://bitbucket.org/site/oauth2/access_token";

pub fn available() -> bool {
    CLIENT_SECRET.is_some_and(|secret| !secret.is_empty())
}

fn secret() -> BitbucketResult<&'static str> {
    CLIENT_SECRET
        .filter(|secret| !secret.is_empty())
        .ok_or_else(|| {
            BitbucketError::Auth(
                "this build cannot sign in through the browser; use an API token instead".into(),
            )
        })
}

fn refused(error: LoopbackError) -> BitbucketError {
    BitbucketError::Auth(error.0)
}

pub fn new_state() -> BitbucketResult<String> {
    sikemux_loopback::new_state().map_err(refused)
}

pub async fn listen() -> BitbucketResult<Callback> {
    Callback::bind(CALLBACK_PATH, "Bitbucket")
        .await
        .map_err(refused)
}

pub async fn code(callback: &Callback, state: &str) -> BitbucketResult<String> {
    callback.code(state).await.map_err(refused)
}

pub fn authorize_url(state: &str) -> String {
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("client_id", CLIENT_ID)
        .append_pair("response_type", "code")
        .append_pair("redirect_uri", &redirect_uri(CALLBACK_PATH))
        .append_pair("state", state)
        .finish();
    format!("{AUTHORIZE_URL}?{query}")
}

#[derive(Deserialize)]
pub struct Tokens {
    pub access_token: String,
    pub refresh_token: String,
    #[serde(default = "default_lifetime")]
    pub expires_in: u64,
    #[serde(default)]
    pub scopes: String,
}

fn default_lifetime() -> u64 {
    3600
}

#[derive(Deserialize)]
struct Refused {
    error: Option<String>,
    error_description: Option<String>,
}

async fn token_request(form: &[(&str, &str)]) -> BitbucketResult<Tokens> {
    let response = client::limited(
        client::http()?
            .post(TOKEN_URL)
            .basic_auth(CLIENT_ID, Some(secret()?))
            .form(form)
            .send(),
    )
    .await?;
    let status = response.status();
    let (bytes, _) = client::read_body(response, 64 * 1024, false).await?;
    if status.is_success() {
        return Ok(serde_json::from_slice(&bytes)?);
    }
    let refused: Option<Refused> = serde_json::from_slice(&bytes).ok();
    let reason = refused
        .and_then(|refused| refused.error_description.or(refused.error))
        .unwrap_or_else(|| format!("http {status}"));
    Err(BitbucketError::Auth(reason))
}

pub async fn exchange(code: &str) -> BitbucketResult<Tokens> {
    token_request(&[
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", &redirect_uri(CALLBACK_PATH)),
    ])
    .await
}

pub async fn refresh(refresh_token: &str) -> BitbucketResult<Tokens> {
    token_request(&[
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
    ])
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_browser_is_sent_back_to_bitbucket_s_own_path_with_a_fresh_state() -> BitbucketResult<()>
    {
        let state = new_state()?;
        let url = authorize_url(&state);
        assert!(url.contains("redirect_uri=http%3A%2F%2Flocalhost%3A47123%2Fbitbucket%2Fcallback"));
        assert!(url.ends_with(&format!("state={state}")));
        Ok(())
    }
}

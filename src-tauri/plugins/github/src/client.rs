// The HTTP side of the GitHub API: one warm client, a cap on how much a
// single answer may be, and GitHub's error shapes turned into ours. Nothing
// here signs in again on its own; a refused token is reported as such.

use std::future::Future;
use std::path::Path;
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures::StreamExt;
use reqwest::header::HeaderMap;
use reqwest::{Client, Method, Response, StatusCode};
use serde::de::DeserializeOwned;
use serde_json::Value;
use tokio::sync::Semaphore;

use crate::config::{self, TokenSource};
use crate::error::{ActionsError, ActionsResult};

const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
const MAX_REQUESTS_IN_FLIGHT: usize = 8;
const API_VERSION: &str = "2022-11-28";

/// Runs `work` once one of the plugin-wide request slots is free, so a screen
/// that fans out over many jobs shares one bound with every other screen.
pub async fn limited<T>(work: impl Future<Output = T>) -> T {
    static PERMITS: OnceLock<Semaphore> = OnceLock::new();
    let _permit = PERMITS
        .get_or_init(|| Semaphore::new(MAX_REQUESTS_IN_FLIGHT))
        .acquire()
        .await
        .ok();
    work.await
}

fn build(redirects: reqwest::redirect::Policy) -> Option<Client> {
    Client::builder()
        .pool_idle_timeout(Duration::from_secs(25))
        .timeout(Duration::from_secs(30))
        .redirect(redirects)
        .user_agent("sikemux-github/0.1")
        .build()
        .ok()
}

fn http() -> ActionsResult<&'static Client> {
    static CLIENT: OnceLock<Option<Client>> = OnceLock::new();
    CLIENT
        .get_or_init(|| build(reqwest::redirect::Policy::none()))
        .as_ref()
        .ok_or_else(|| ActionsError::Transport("could not start the HTTP client".into()))
}

/// Where a request goes and which token it carries.
pub struct Session {
    pub host: String,
    pub token: String,
    pub source: TokenSource,
}

impl Session {
    /// Read fresh every time, so a `gh auth login` in a terminal is picked up
    /// without restarting the app.
    pub fn current(data_dir: &Path) -> ActionsResult<Session> {
        let config = config::load(data_dir);
        let (token, source) = config::resolve_token(&config).ok_or(ActionsError::Unconfigured)?;
        Ok(Session {
            host: config.host,
            token,
            source,
        })
    }
}

async fn read_limited(response: Response) -> ActionsResult<Vec<u8>> {
    if response
        .content_length()
        .is_some_and(|size| size > MAX_RESPONSE_BYTES as u64)
    {
        return Err(ActionsError::Response(
            "more than 16 MiB came back; narrow the request".into(),
        ));
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err(ActionsError::Response(
                "more than 16 MiB came back; narrow the request".into(),
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_secs())
        .unwrap_or(0)
}

/// GitHub reports a spent rate limit as a 403 with the remaining count at
/// zero, which is worth telling apart from a token that simply may not.
fn rate_limited_for(headers: &HeaderMap) -> Option<u64> {
    let number = |name: &str| -> Option<u64> {
        headers.get(name)?.to_str().ok()?.trim().parse::<u64>().ok()
    };
    if let Some(retry_after) = number("retry-after") {
        return Some(retry_after);
    }
    if number("x-ratelimit-remaining")? != 0 {
        return None;
    }
    Some(
        number("x-ratelimit-reset")
            .unwrap_or(0)
            .saturating_sub(now_secs()),
    )
}

fn error_message(bytes: &[u8]) -> Option<String> {
    let body: Value = serde_json::from_slice(bytes).ok()?;
    let message = body.get("message")?.as_str()?.to_string();
    let detail = body
        .get("errors")
        .and_then(Value::as_array)
        .and_then(|errors| errors.first())
        .and_then(|first| {
            first
                .get("message")
                .or_else(|| first.get("code"))
                .and_then(Value::as_str)
        });
    Some(match detail {
        Some(detail) if !message.contains(detail) => format!("{message}: {detail}"),
        _ => message,
    })
}

pub fn classify(status: StatusCode, headers: &HeaderMap, bytes: &[u8]) -> ActionsError {
    let message = error_message(bytes).unwrap_or_else(|| {
        status
            .canonical_reason()
            .unwrap_or("the request failed")
            .to_string()
    });
    match status.as_u16() {
        401 => ActionsError::Auth(message),
        403 | 429 => match rate_limited_for(headers) {
            Some(resets_in_secs) => ActionsError::RateLimited { resets_in_secs },
            None => ActionsError::Forbidden(message),
        },
        404 => ActionsError::NotFound(message),
        status => ActionsError::Http { status, message },
    }
}

async fn send_accepting(
    session: &Session,
    path: &str,
    accept: &str,
) -> ActionsResult<(StatusCode, HeaderMap, Vec<u8>)> {
    let url = format!("{}{path}", config::api_base(&session.host));
    let request = http()?
        .get(url)
        .bearer_auth(&session.token)
        .header("Accept", accept)
        .header("X-GitHub-Api-Version", API_VERSION);
    let response = limited(request.send()).await?;
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = read_limited(response).await?;
    Ok((status, headers, bytes))
}

pub async fn send(
    session: &Session,
    method: Method,
    path: &str,
    query: &[(&str, String)],
    body: Option<&Value>,
) -> ActionsResult<(StatusCode, HeaderMap, Vec<u8>)> {
    let url = format!("{}{path}", config::api_base(&session.host));
    let mut request = http()?
        .request(method, url)
        .bearer_auth(&session.token)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", API_VERSION);
    if !query.is_empty() {
        request = request.query(query);
    }
    if let Some(body) = body {
        request = request.json(body);
    }
    let response = limited(request.send()).await?;
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = read_limited(response).await?;
    if status == StatusCode::UNAUTHORIZED {
        config::forget_token();
    }
    Ok((status, headers, bytes))
}

pub async fn request<T: DeserializeOwned>(
    session: &Session,
    method: Method,
    path: &str,
    query: &[(&str, String)],
    body: Option<&Value>,
) -> ActionsResult<T> {
    let (status, headers, bytes) = send(session, method, path, query, body).await?;
    if !status.is_success() {
        return Err(classify(status, &headers, &bytes));
    }
    if bytes.iter().all(u8::is_ascii_whitespace) {
        return Ok(serde_json::from_value(Value::Null)?);
    }
    Ok(serde_json::from_slice(&bytes)?)
}

pub async fn get<T: DeserializeOwned>(
    data_dir: &Path,
    path: &str,
    query: &[(&str, String)],
) -> ActionsResult<T> {
    let session = Session::current(data_dir)?;
    request(&session, Method::GET, path, query, None).await
}

/// A write whose answer is the thing it made, such as a new pull request or issue.
pub async fn send_json<T: DeserializeOwned>(
    data_dir: &Path,
    method: Method,
    path: &str,
    body: &Value,
) -> ActionsResult<T> {
    let session = Session::current(data_dir)?;
    request(&session, method, path, &[], Some(body)).await
}

pub async fn post_empty(data_dir: &Path, path: &str, body: Option<&Value>) -> ActionsResult<()> {
    act(data_dir, Method::POST, path, body).await
}

/// Logs and artifacts are served as a redirect to storage that must be
/// followed without the token, since the signed URL carries its own
/// permission and GitHub rejects a request that sends both.
pub async fn download(data_dir: &Path, path: &str) -> ActionsResult<Vec<u8>> {
    download_as(data_dir, path, "application/vnd.github+json").await
}

/// The same, for an endpoint that only hands over the bytes when asked for
/// them by content type rather than as JSON.
pub async fn download_as(data_dir: &Path, path: &str, accept: &str) -> ActionsResult<Vec<u8>> {
    let session = Session::current(data_dir)?;
    let (status, headers, bytes) = send_accepting(&session, path, accept).await?;
    if status.is_success() {
        return Ok(bytes);
    }
    if !status.is_redirection() {
        return Err(classify(status, &headers, &bytes));
    }
    let location = headers
        .get("location")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| ActionsError::Response("the download redirect had no address".into()))?;
    let response = limited(http()?.execute(from_storage(location)?)).await?;
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = read_limited(response).await?;
    if !status.is_success() {
        return Err(classify(status, &headers, &bytes));
    }
    Ok(bytes)
}

/// Storage answers 400 to any `Authorization` header, an empty one included.
fn from_storage(location: &str) -> ActionsResult<reqwest::Request> {
    let url = reqwest::Url::parse(location)
        .map_err(|_| ActionsError::Response("the download redirect was not an address".into()))?;
    Ok(reqwest::Request::new(Method::GET, url))
}

pub async fn download_text(data_dir: &Path, path: &str) -> ActionsResult<String> {
    Ok(String::from_utf8_lossy(&download(data_dir, path).await?).into_owned())
}

/// A call whose answer is only its status, which is how GitHub replies to the
/// buttons that start, stop, approve or switch something off.
pub async fn act(
    data_dir: &Path,
    method: Method,
    path: &str,
    body: Option<&Value>,
) -> ActionsResult<()> {
    let session = Session::current(data_dir)?;
    let (status, headers, bytes) = send(&session, method, path, &[], body).await?;
    if status.is_success() {
        return Ok(());
    }
    Err(classify(status, &headers, &bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::header::HeaderValue;

    fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            if let Ok(value) = HeaderValue::from_str(value) {
                map.insert(*name, value);
            }
        }
        map
    }

    fn category(status: u16, headers: &HeaderMap, body: &str) -> String {
        let status = StatusCode::from_u16(status).unwrap_or(StatusCode::OK);
        sikemux_plugin_api::PluginError::from(classify(status, headers, body.as_bytes())).category
    }

    #[test]
    fn tells_a_spent_rate_limit_apart_from_a_token_that_may_not() {
        let spent = headers(&[("x-ratelimit-remaining", "0"), ("x-ratelimit-reset", "0")]);
        let allowed = headers(&[("x-ratelimit-remaining", "412")]);
        assert_eq!(category(403, &spent, "{}"), "rate-limited");
        assert_eq!(category(403, &allowed, "{}"), "forbidden");
        assert_eq!(category(403, &HeaderMap::new(), "{}"), "forbidden");
        assert_eq!(
            category(429, &headers(&[("retry-after", "30")]), "{}"),
            "rate-limited"
        );
    }

    #[test]
    fn maps_the_statuses_a_caller_branches_on() {
        let none = HeaderMap::new();
        assert_eq!(category(401, &none, "{}"), "auth");
        assert_eq!(category(404, &none, "{}"), "not-found");
        assert_eq!(category(422, &none, "{}"), "http");
        assert_eq!(category(500, &none, "{}"), "http");
    }

    #[test]
    fn error_messages_come_from_the_body_and_carry_the_first_detail() {
        let body = r#"{"message":"Validation Failed","errors":[{"message":"no ref named x"}]}"#;
        assert_eq!(
            error_message(body.as_bytes()).as_deref(),
            Some("Validation Failed: no ref named x")
        );
        assert_eq!(
            error_message(br#"{"message":"Not Found"}"#).as_deref(),
            Some("Not Found")
        );
        assert_eq!(error_message(b"<html>"), None);
    }

    #[test]
    fn a_download_from_storage_carries_no_authorization_header() {
        let request = from_storage("https://storage.example/log?sig=abc").expect("builds");
        assert!(request
            .headers()
            .get(reqwest::header::AUTHORIZATION)
            .is_none());
    }

    #[test]
    fn a_body_with_no_message_still_says_something_useful() {
        let error = classify(StatusCode::BAD_GATEWAY, &HeaderMap::new(), b"");
        assert!(error.to_string().contains("Bad Gateway"), "{error}");
    }
}

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
use crate::error::{GithubError, GithubResult};

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

/// Files can be large and slow, so a transfer has no overall deadline, only
/// one on connecting and one on going quiet.
fn transfers() -> GithubResult<&'static Client> {
    static CLIENT: OnceLock<Option<Client>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            Client::builder()
                .connect_timeout(Duration::from_secs(30))
                .read_timeout(Duration::from_secs(60))
                .redirect(reqwest::redirect::Policy::none())
                .user_agent("sikemux-github/0.1")
                .build()
                .ok()
        })
        .as_ref()
        .ok_or_else(|| GithubError::Transport("could not start the HTTP client".into()))
}

fn http() -> GithubResult<&'static Client> {
    static CLIENT: OnceLock<Option<Client>> = OnceLock::new();
    CLIENT
        .get_or_init(|| build(reqwest::redirect::Policy::none()))
        .as_ref()
        .ok_or_else(|| GithubError::Transport("could not start the HTTP client".into()))
}

pub struct Session {
    pub host: String,
    pub token: String,
    pub source: TokenSource,
}

impl Session {
    /// Read fresh every time, so a `gh auth login` in a terminal is picked up
    /// without restarting the app.
    pub fn current(data_dir: &Path) -> GithubResult<Session> {
        let config = config::load(data_dir);
        let (token, source) = config::resolve_token(&config).ok_or(GithubError::Unconfigured)?;
        Ok(Session {
            host: config.host,
            token,
            source,
        })
    }
}

async fn read_limited(response: Response) -> GithubResult<Vec<u8>> {
    if response
        .content_length()
        .is_some_and(|size| size > MAX_RESPONSE_BYTES as u64)
    {
        return Err(GithubError::Response(
            "more than 16 MiB came back; narrow the request".into(),
        ));
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err(GithubError::Response(
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

pub fn classify(status: StatusCode, headers: &HeaderMap, bytes: &[u8]) -> GithubError {
    let message = error_message(bytes).unwrap_or_else(|| {
        status
            .canonical_reason()
            .unwrap_or("the request failed")
            .to_string()
    });
    match status.as_u16() {
        401 => GithubError::Auth(message),
        403 | 429 => match rate_limited_for(headers) {
            Some(resets_in_secs) => GithubError::RateLimited { resets_in_secs },
            None => GithubError::Forbidden(message),
        },
        404 => GithubError::NotFound(message),
        status => GithubError::Http { status, message },
    }
}

async fn send_accepting(
    session: &Session,
    path: &str,
    accept: &str,
) -> GithubResult<(StatusCode, HeaderMap, Vec<u8>)> {
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
) -> GithubResult<(StatusCode, HeaderMap, Vec<u8>)> {
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

/// The body of a successful answer. The network half of every call lives in
/// these functions, which are not generic, so each shape of answer only adds
/// its own parsing to the app rather than another copy of the request.
async fn body_of(
    session: &Session,
    method: Method,
    path: &str,
    query: &[(&str, String)],
    body: Option<&Value>,
) -> GithubResult<Vec<u8>> {
    let (status, headers, bytes) = send(session, method, path, query, body).await?;
    if !status.is_success() {
        return Err(classify(status, &headers, &bytes));
    }
    Ok(bytes)
}

async fn fetch(
    data_dir: &Path,
    method: Method,
    path: &str,
    query: &[(&str, String)],
    body: Option<&Value>,
) -> GithubResult<Vec<u8>> {
    let session = Session::current(data_dir)?;
    body_of(&session, method, path, query, body).await
}

fn parse<T: DeserializeOwned>(bytes: &[u8]) -> GithubResult<T> {
    if bytes.iter().all(u8::is_ascii_whitespace) {
        return Ok(serde_json::from_slice(b"null")?);
    }
    Ok(serde_json::from_slice(bytes)?)
}

pub async fn get<T: DeserializeOwned>(
    data_dir: &Path,
    path: &str,
    query: &[(&str, String)],
) -> GithubResult<T> {
    parse(&fetch(data_dir, Method::GET, path, query, None).await?)
}

/// A write whose answer is the thing it made, such as a new pull request or issue.
pub async fn send_json<T: DeserializeOwned>(
    data_dir: &Path,
    method: Method,
    path: &str,
    body: &Value,
) -> GithubResult<T> {
    parse(&fetch(data_dir, method, path, &[], Some(body)).await?)
}

/// Every page of a list GitHub splits into pages of a hundred, up to
/// `max_pages` of them. `items` takes the list out of a page, for the
/// endpoints that wrap it in an object.
pub async fn get_all<P: DeserializeOwned, T>(
    data_dir: &Path,
    path: &str,
    query: &[(&str, String)],
    max_pages: u32,
    items: impl Fn(P) -> Vec<T>,
) -> GithubResult<Vec<T>> {
    const PAGE: usize = 100;
    let mut all = Vec::new();
    for page in 1..=max_pages.max(1) {
        let mut paged = query.to_vec();
        paged.push(("per_page", PAGE.to_string()));
        paged.push(("page", page.to_string()));
        let batch = items(get::<P>(data_dir, path, &paged).await?);
        let short = batch.len() < PAGE;
        all.extend(batch);
        if short {
            break;
        }
    }
    Ok(all)
}

/// An answer to a conditional read. GitHub does not count a "nothing changed"
/// answer against the rate limit, which is what lets a run be watched closely.
pub struct Conditional<T> {
    /// Absent when nothing changed since `etag`.
    pub value: Option<T>,
    pub etag: Option<String>,
    /// Requests left before the rate limit, when GitHub said.
    pub remaining: Option<u64>,
}

pub async fn get_if_changed<T: DeserializeOwned>(
    data_dir: &Path,
    path: &str,
    query: &[(&str, String)],
    etag: Option<&str>,
) -> GithubResult<Conditional<T>> {
    let (bytes, etag, remaining) = fetch_if_changed(data_dir, path, query, etag).await?;
    Ok(Conditional {
        value: bytes.as_deref().map(parse).transpose()?,
        etag,
        remaining,
    })
}

async fn fetch_if_changed(
    data_dir: &Path,
    path: &str,
    query: &[(&str, String)],
    etag: Option<&str>,
) -> GithubResult<(Option<Vec<u8>>, Option<String>, Option<u64>)> {
    let session = Session::current(data_dir)?;
    let url = format!("{}{path}", config::api_base(&session.host));
    let mut request = http()?
        .get(url)
        .bearer_auth(&session.token)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", API_VERSION)
        .query(query);
    if let Some(etag) = etag {
        request = request.header("If-None-Match", etag);
    }
    let response = limited(request.send()).await?;
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = read_limited(response).await?;
    let header = |name: &str| headers.get(name).and_then(|value| value.to_str().ok());
    let remaining = header("x-ratelimit-remaining").and_then(|value| value.trim().parse().ok());
    if status == StatusCode::NOT_MODIFIED {
        return Ok((None, etag.map(str::to_string), remaining));
    }
    if !status.is_success() {
        if status == StatusCode::UNAUTHORIZED {
            config::forget_token();
        }
        return Err(classify(status, &headers, &bytes));
    }
    Ok((Some(bytes), header("etag").map(str::to_string), remaining))
}

pub async fn post_empty(data_dir: &Path, path: &str, body: Option<&Value>) -> GithubResult<()> {
    act(data_dir, Method::POST, path, body).await
}

/// Logs and artifacts are served as a redirect to storage that must be
/// followed without the token, since the signed URL carries its own
/// permission and GitHub rejects a request that sends both.
pub async fn download(data_dir: &Path, path: &str) -> GithubResult<Vec<u8>> {
    download_as(data_dir, path, "application/vnd.github+json").await
}

/// The same, for an endpoint that only hands over the bytes when asked for
/// them by content type rather than as JSON.
pub async fn download_as(data_dir: &Path, path: &str, accept: &str) -> GithubResult<Vec<u8>> {
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
        .ok_or_else(|| GithubError::Response("the download redirect had no address".into()))?;
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
fn from_storage(location: &str) -> GithubResult<reqwest::Request> {
    let url = reqwest::Url::parse(location)
        .map_err(|_| GithubError::Response("the download redirect was not an address".into()))?;
    Ok(reqwest::Request::new(Method::GET, url))
}

/// Writes a file GitHub hands over, an artifact or a release asset, to
/// `target` as it arrives, however large it is. It lands under a temporary
/// name first, so a download cut short never looks finished.
pub async fn download_to(
    data_dir: &Path,
    path: &str,
    accept: &str,
    target: &Path,
) -> GithubResult<u64> {
    let session = Session::current(data_dir)?;
    let url = format!("{}{path}", config::api_base(&session.host));
    let request = transfers()?
        .get(url)
        .bearer_auth(&session.token)
        .header("Accept", accept)
        .header("X-GitHub-Api-Version", API_VERSION);
    let mut response = limited(request.send()).await?;
    if response.status().is_redirection() {
        let location = response
            .headers()
            .get("location")
            .and_then(|value| value.to_str().ok())
            .ok_or_else(|| GithubError::Response("the download redirect had no address".into()))?
            .to_string();
        response = limited(transfers()?.execute(from_storage(&location)?)).await?;
    }
    let status = response.status();
    if !status.is_success() {
        let headers = response.headers().clone();
        let bytes = read_limited(response).await.unwrap_or_default();
        return Err(classify(status, &headers, &bytes));
    }
    write_stream(response, target).await
}

async fn write_stream(response: Response, target: &Path) -> GithubResult<u64> {
    use std::io::Write;
    let failed =
        |error: std::io::Error| GithubError::Transport(format!("saving the download: {error}"));
    let partial = target.with_extension(match target.extension() {
        Some(extension) => format!("{}.part", extension.to_string_lossy()),
        None => "part".to_string(),
    });
    let mut file = std::fs::File::create(&partial).map_err(failed)?;
    let mut stream = response.bytes_stream();
    let mut written: u64 = 0;
    let outcome: GithubResult<()> = async {
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            file.write_all(&chunk).map_err(failed)?;
            written += chunk.len() as u64;
        }
        file.flush().map_err(failed)
    }
    .await;
    drop(file);
    if let Err(error) = outcome {
        std::fs::remove_file(&partial).ok();
        return Err(error);
    }
    std::fs::rename(&partial, target).map_err(failed)?;
    Ok(written)
}

pub async fn download_text(data_dir: &Path, path: &str) -> GithubResult<String> {
    Ok(String::from_utf8_lossy(&download(data_dir, path).await?).into_owned())
}

/// A call whose answer is only its status, which is how GitHub replies to the
/// buttons that start, stop, approve or switch something off.
pub async fn act(
    data_dir: &Path,
    method: Method,
    path: &str,
    body: Option<&Value>,
) -> GithubResult<()> {
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

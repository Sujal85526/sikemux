//! What a release says about itself: its notes and who made it. The release
//! script writes both into the `latest.json` it attaches to every release, and
//! avatars are fetched here because the window only draws `data:` images.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use base64::Engine;
use futures::future::join_all;
use futures::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{AppError, AppResult};

const AVATAR_ORIGIN: &str = "https://avatars.githubusercontent.com/";
const COMPARE_PREFIX: &str = "https://github.com/nodelike/sikemux/compare/";
const RELEASE_DOWNLOADS: &str = "https://github.com/nodelike/sikemux/releases/download/";
const FETCH_TIMEOUT: Duration = Duration::from_secs(8);
/// The modal draws avatars at 30 points, so 64 pixels stays sharp on a retina screen.
const AVATAR_PIXELS: u32 = 64;
const MAX_AVATAR_BYTES: usize = 64 * 1024;
const MAX_AVATARS: usize = 64;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Contributor {
    login: String,
    name: String,
    commits: u32,
    avatar: String,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Credits {
    pub date: Option<String>,
    pub commits: Option<u32>,
    pub compare: Option<String>,
    pub contributors: Vec<Contributor>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseNotes {
    version: String,
    notes: Option<String>,
    date: Option<String>,
    commits: Option<u32>,
    compare: Option<String>,
    contributors: Vec<Contributor>,
}

#[derive(Default, Deserialize)]
struct Feed {
    #[serde(default)]
    pub_date: Option<String>,
    #[serde(default)]
    commits: Option<u32>,
    #[serde(default)]
    compare: Option<String>,
    #[serde(default)]
    contributors: Vec<Value>,
}

/// Reads the credits out of the whole update feed. A contributor the feed
/// describes badly is dropped rather than failing the update check.
pub fn from_feed(feed: &Value) -> Credits {
    let feed: Feed = serde_json::from_value(feed.clone()).unwrap_or_default();
    Credits {
        date: feed.pub_date,
        commits: feed.commits,
        compare: feed.compare.filter(|url| url.starts_with(COMPARE_PREFIX)),
        contributors: feed
            .contributors
            .into_iter()
            .filter_map(|entry| serde_json::from_value::<Contributor>(entry).ok())
            .filter(|person| valid_login(&person.login) && person.avatar.starts_with(AVATAR_ORIGIN))
            .collect(),
    }
}

/// The notes of one published release, read from the feed attached to it.
#[tauri::command]
pub async fn release_notes(version: String) -> AppResult<ReleaseNotes> {
    if version.is_empty()
        || !version
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+'))
    {
        return Err(AppError::BadArg(
            "a release version is digits, letters, dots and hyphens",
        ));
    }
    let response = client()
        .get(format!("{RELEASE_DOWNLOADS}v{version}/latest.json"))
        .send()
        .await?;
    if !response.status().is_success() {
        return Err(AppError::Other(format!(
            "GitHub has no release notes for v{version} ({})",
            response.status()
        )));
    }
    let feed: Value = response.json().await?;
    Ok(notes_from_feed(&feed, version))
}

fn notes_from_feed(feed: &Value, version: String) -> ReleaseNotes {
    let credits = from_feed(feed);
    ReleaseNotes {
        version,
        notes: feed.get("notes").and_then(Value::as_str).map(str::to_owned),
        date: credits.date,
        commits: credits.commits,
        compare: credits.compare,
        contributors: credits.contributors,
    }
}

/// GitHub logins are letters, digits and single hyphens, at most 39 long.
fn valid_login(login: &str) -> bool {
    !login.is_empty()
        && login.len() <= 39
        && !login.starts_with('-')
        && login.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// Avatars keyed by the address the feed gave. One that fails to load is left
/// out, and the modal draws the contributor's initial instead.
#[tauri::command]
pub async fn release_avatars(urls: Vec<String>) -> HashMap<String, String> {
    let wanted: Vec<String> = urls
        .into_iter()
        .filter(|url| url.starts_with(AVATAR_ORIGIN))
        .take(MAX_AVATARS)
        .collect();
    let fetched = join_all(wanted.into_iter().map(|url| async move {
        if let Some(known) = cached(&url) {
            return (url, known);
        }
        let data = fetch(&url).await;
        remember(&url, data.clone());
        (url, data)
    }))
    .await;
    fetched
        .into_iter()
        .filter_map(|(url, data)| data.map(|data| (url, data)))
        .collect()
}

fn cache() -> &'static Mutex<HashMap<String, Option<String>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

fn cached(url: &str) -> Option<Option<String>> {
    cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(url)
        .cloned()
}

fn remember(url: &str, data: Option<String>) {
    cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(url.to_owned(), data);
}

fn sized(url: &str) -> String {
    let separator = if url.contains('?') { '&' } else { '?' };
    format!("{url}{separator}s={AVATAR_PIXELS}")
}

async fn fetch(url: &str) -> Option<String> {
    let response = client().get(sized(url)).send().await.ok()?;
    if !response.status().is_success()
        || response
            .content_length()
            .is_some_and(|length| length > MAX_AVATAR_BYTES as u64)
    {
        return None;
    }
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.ok()?;
        if body.len() + chunk.len() > MAX_AVATAR_BYTES {
            return None;
        }
        body.extend_from_slice(&chunk);
    }
    let mime = image_type(&body)?;
    Some(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&body)
    ))
}

fn image_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("image/png");
    }
    if bytes.starts_with(b"\xff\xd8\xff") {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"GIF8") {
        return Some("image/gif");
    }
    if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        return Some("image/webp");
    }
    None
}

fn client() -> &'static Client {
    static CLIENT: OnceLock<Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        Client::builder()
            .timeout(FETCH_TIMEOUT)
            .build()
            .unwrap_or_default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn person(login: &str, avatar: &str) -> Value {
        json!({ "login": login, "name": login, "commits": 3, "avatar": avatar })
    }

    #[test]
    fn reads_the_credits_the_release_script_writes() {
        let credits = from_feed(&json!({
            "version": "0.4.0",
            "notes": "# Sikemux v0.4.0",
            "pub_date": "2026-09-22T12:45:39Z",
            "commits": 442,
            "compare": "https://github.com/nodelike/sikemux/compare/v0.3.5...v0.4.0",
            "contributors": [{
                "login": "nodelike",
                "name": "NØDE",
                "commits": 441,
                "avatar": "https://avatars.githubusercontent.com/u/108696612?v=4"
            }],
            "platforms": {}
        }));

        assert_eq!(credits.date.as_deref(), Some("2026-09-22T12:45:39Z"));
        assert_eq!(credits.commits, Some(442));
        assert_eq!(
            credits.compare.as_deref(),
            Some("https://github.com/nodelike/sikemux/compare/v0.3.5...v0.4.0")
        );
        assert_eq!(
            credits.contributors,
            vec![Contributor {
                login: "nodelike".into(),
                name: "NØDE".into(),
                commits: 441,
                avatar: "https://avatars.githubusercontent.com/u/108696612?v=4".into(),
            }]
        );
    }

    #[test]
    fn a_release_feed_carries_its_notes() {
        let notes = notes_from_feed(
            &json!({ "version": "0.4.0", "notes": "# Sikemux v0.4.0", "commits": 3 }),
            "0.4.0".into(),
        );
        assert_eq!(notes.notes.as_deref(), Some("# Sikemux v0.4.0"));
        assert_eq!(notes.commits, Some(3));
    }

    #[test]
    fn a_feed_without_credits_still_reads() {
        assert_eq!(
            from_feed(&json!({ "version": "0.3.5", "notes": "" })),
            Credits::default()
        );
    }

    #[test]
    fn drops_contributors_and_links_that_do_not_point_at_github() {
        let credits = from_feed(&json!({
            "compare": "https://example.com/compare/v1...v2",
            "contributors": [
                person("ok-name", "https://avatars.githubusercontent.com/u/1?v=4"),
                person("evil", "https://example.com/tracker.png"),
                person("../../settings", "https://avatars.githubusercontent.com/u/2?v=4"),
                person("-leading", "https://avatars.githubusercontent.com/u/3?v=4"),
                { "login": "no-avatar" }
            ]
        }));

        assert_eq!(credits.compare, None);
        let logins: Vec<&str> = credits
            .contributors
            .iter()
            .map(|c| c.login.as_str())
            .collect();
        assert_eq!(logins, ["ok-name"]);
    }

    #[test]
    fn asks_github_for_a_small_avatar() {
        assert_eq!(
            sized("https://avatars.githubusercontent.com/u/1?v=4"),
            "https://avatars.githubusercontent.com/u/1?v=4&s=64"
        );
        assert_eq!(
            sized("https://avatars.githubusercontent.com/u/1"),
            "https://avatars.githubusercontent.com/u/1?s=64"
        );
    }

    #[test]
    fn only_image_bytes_become_data_urls() {
        assert_eq!(image_type(b"\x89PNG\r\n\x1a\nrest"), Some("image/png"));
        assert_eq!(image_type(b"\xff\xd8\xff\xe0"), Some("image/jpeg"));
        assert_eq!(image_type(b"<html>not found</html>"), None);
    }
}

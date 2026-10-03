//! The signed-in account's name and picture, kept on disk so the top bar can
//! show them offline. The picture is downloaded here and handed to the window
//! as a `data:` URL, because the window's security policy blocks remote images.

use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use futures::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::release_credits::image_type;

const PROFILE_FILE: &str = "profile.json";
const PICTURE_PREFIX: &str = "picture-";
const MAX_PICTURE_BYTES: usize = 1024 * 1024;
const MAX_REDIRECTS: usize = 5;
const FETCH_TIMEOUT: Duration = Duration::from_secs(15);
pub const CHECK_EVERY: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Profile {
    pub user_id: String,
    pub name: Option<String>,
    pub email: Option<String>,
    pub picture: Option<String>,
    pub checked_at: u64,
}

impl Profile {
    pub fn is_stale(&self, now: u64) -> bool {
        now.saturating_sub(self.checked_at) >= CHECK_EVERY.as_secs()
    }
}

/// What Clerk's `/oauth/userinfo` answers for the `email profile` scopes.
#[derive(Debug, Default, Deserialize)]
pub struct UserInfo {
    pub email: Option<String>,
    name: Option<String>,
    given_name: Option<String>,
    family_name: Option<String>,
    picture: Option<String>,
}

impl UserInfo {
    pub fn into_profile(self, user_id: String, now: u64) -> Profile {
        let joined = [self.given_name, self.family_name]
            .into_iter()
            .flatten()
            .map(|part| part.trim().to_owned())
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        let name = self
            .name
            .map(|name| name.trim().to_owned())
            .filter(|name| !name.is_empty())
            .or_else(|| (!joined.is_empty()).then_some(joined));
        Profile {
            user_id,
            name,
            email: self.email,
            picture: self.picture.filter(|url| picture_url_allowed(url)),
            checked_at: now,
        }
    }
}

pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or_default()
}

fn picture_url_allowed(url: &str) -> bool {
    url::Url::parse(url).is_ok_and(|url| url.scheme() == "https" && url.host_str().is_some())
}

fn cache_key(url: &str) -> String {
    hex::encode(Sha256::digest(url.as_bytes()).get(..16).unwrap_or_default())
}

fn picture_path(dir: &Path, url: &str) -> PathBuf {
    dir.join(format!("{PICTURE_PREFIX}{}", cache_key(url)))
}

fn content_type_allowed(header: Option<&str>) -> bool {
    header.is_some_and(|value| value.trim().to_ascii_lowercase().starts_with("image/"))
}

/// The picture as a `data:` URL, or nothing if it is not a known image or too large.
fn data_url(bytes: &[u8]) -> Option<String> {
    if bytes.len() > MAX_PICTURE_BYTES {
        return None;
    }
    let mime = image_type(bytes)?;
    Some(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

pub async fn read(dir: &Path) -> Option<Profile> {
    let text = tokio::fs::read(dir.join(PROFILE_FILE)).await.ok()?;
    serde_json::from_slice(&text).ok()
}

pub async fn picture(dir: &Path, profile: &Profile) -> Option<String> {
    let url = profile.picture.as_deref()?;
    data_url(&tokio::fs::read(picture_path(dir, url)).await.ok()?)
}

/// Saves the profile and fetches its picture if it is not cached yet. A picture
/// that fails to download is left out until the next check.
pub async fn save(dir: &Path, profile: &Profile) -> std::io::Result<()> {
    tokio::fs::create_dir_all(dir).await?;
    tokio::fs::write(dir.join(PROFILE_FILE), serde_json::to_vec(profile)?).await?;
    let keep = profile.picture.as_deref().map(|url| picture_path(dir, url));
    if let (Some(url), Some(path)) = (profile.picture.as_deref(), keep.as_deref()) {
        if tokio::fs::metadata(path).await.is_err() {
            if let Some(bytes) = download(url).await {
                tokio::fs::write(path, bytes).await?;
            }
        }
    }
    let mut entries = tokio::fs::read_dir(dir).await?;
    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();
        let is_picture = entry
            .file_name()
            .to_str()
            .is_some_and(|name| name.starts_with(PICTURE_PREFIX));
        if is_picture && Some(&path) != keep.as_ref() {
            let _ = tokio::fs::remove_file(path).await;
        }
    }
    Ok(())
}

pub async fn forget(dir: &Path) -> std::io::Result<()> {
    match tokio::fs::remove_dir_all(dir).await {
        Err(error) if error.kind() != ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

fn client() -> &'static Client {
    static CLIENT: OnceLock<Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        let https_only = reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() < MAX_REDIRECTS && attempt.url().scheme() == "https" {
                attempt.follow()
            } else {
                attempt.stop()
            }
        });
        Client::builder()
            .timeout(FETCH_TIMEOUT)
            .redirect(https_only)
            .user_agent(concat!("sikemux/", env!("CARGO_PKG_VERSION")))
            .build()
            .unwrap_or_default()
    })
}

async fn download(url: &str) -> Option<Vec<u8>> {
    if !picture_url_allowed(url) {
        return None;
    }
    let response = client().get(url).send().await.ok()?;
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok());
    if !response.status().is_success()
        || !content_type_allowed(content_type)
        || response
            .content_length()
            .is_some_and(|length| length > MAX_PICTURE_BYTES as u64)
    {
        return None;
    }
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.ok()?;
        if body.len() + chunk.len() > MAX_PICTURE_BYTES {
            return None;
        }
        body.extend_from_slice(&chunk);
    }
    data_url(&body).is_some().then_some(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\nrest";

    #[test]
    fn only_https_pictures_are_fetched() {
        assert!(picture_url_allowed("https://img.clerk.com/abc"));
        assert!(!picture_url_allowed("http://img.clerk.com/abc"));
        assert!(!picture_url_allowed("file:///etc/passwd"));
        assert!(!picture_url_allowed("data:image/png;base64,AAAA"));
        assert!(!picture_url_allowed("not a url"));
    }

    #[test]
    fn the_cache_key_is_a_stable_hash_of_the_url() {
        let key = cache_key("https://img.clerk.com/abc");
        assert_eq!(key.len(), 32);
        assert!(key.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(key, cache_key("https://img.clerk.com/abc"));
        assert_ne!(key, cache_key("https://img.clerk.com/abd"));
    }

    #[test]
    fn only_image_content_types_are_accepted() {
        assert!(content_type_allowed(Some("image/png")));
        assert!(content_type_allowed(Some("Image/JPEG; charset=binary")));
        assert!(!content_type_allowed(Some("text/html")));
        assert!(!content_type_allowed(None));
    }

    #[test]
    fn a_picture_must_be_a_known_image_under_the_size_cap() {
        assert!(data_url(PNG).is_some_and(|url| url.starts_with("data:image/png;base64,")));
        assert_eq!(data_url(b"<svg onload=alert(1)>"), None);
        let mut huge = PNG.to_vec();
        huge.resize(MAX_PICTURE_BYTES + 1, 0);
        assert_eq!(data_url(&huge), None);
    }

    #[test]
    fn the_name_falls_back_to_given_and_family_names() {
        let info = UserInfo {
            email: Some("a@b.c".into()),
            name: Some("  ".into()),
            given_name: Some("Ada".into()),
            family_name: Some("Lovelace".into()),
            picture: Some("http://insecure.example/p.png".into()),
        };
        let profile = info.into_profile("user_1".into(), 7);
        assert_eq!(profile.name.as_deref(), Some("Ada Lovelace"));
        assert_eq!(profile.picture, None);
        assert_eq!(profile.checked_at, 7);
    }

    #[test]
    fn a_profile_goes_stale_after_the_check_interval() {
        let profile = Profile {
            checked_at: 1_000,
            ..Profile::default()
        };
        assert!(!profile.is_stale(1_000 + CHECK_EVERY.as_secs() - 1));
        assert!(profile.is_stale(1_000 + CHECK_EVERY.as_secs()));
    }

    #[tokio::test]
    async fn the_cache_keeps_only_the_current_picture_and_is_forgotten_on_sign_out() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("account");
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let current = "https://img.clerk.com/new";
        tokio::fs::write(picture_path(&dir, current), PNG)
            .await
            .unwrap();
        tokio::fs::write(picture_path(&dir, "https://img.clerk.com/old"), PNG)
            .await
            .unwrap();
        let profile = Profile {
            user_id: "user_1".into(),
            picture: Some(current.into()),
            ..Profile::default()
        };
        save(&dir, &profile).await.unwrap();

        assert_eq!(read(&dir).await, Some(profile.clone()));
        assert!(picture(&dir, &profile)
            .await
            .is_some_and(|url| url.starts_with("data:image/png;base64,")));
        let mut names = Vec::new();
        let mut entries = tokio::fs::read_dir(&dir).await.unwrap();
        while let Some(entry) = entries.next_entry().await.unwrap() {
            names.push(entry.file_name().into_string().unwrap());
        }
        names.sort();
        assert_eq!(
            names,
            vec![
                format!("{PICTURE_PREFIX}{}", cache_key(current)),
                PROFILE_FILE.to_owned()
            ]
        );

        forget(&dir).await.unwrap();
        assert!(read(&dir).await.is_none());
        forget(&dir).await.unwrap();
    }
}

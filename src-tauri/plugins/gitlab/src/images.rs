// Avatars and pictures GitLab shows beside its text. The window only draws
// images the app holds itself, so each is fetched here and handed over as a
// `data:` address. The token only ever goes to the account's own server.

use std::path::Path;

use base64::Engine;
use reqwest::Url;
use serde::Deserialize;

use crate::client::{self, Session};
use crate::error::{GitlabError, GitlabResult};

const MAX_IMAGE_BYTES: usize = 5 * 1024 * 1024;

#[derive(Deserialize)]
pub struct ImageRef {
    pub url: String,
}

/// Whether an image may be fetched, and if so whether it gets the token: only
/// the account's own server does. Gravatar and GitLab's own image hosts need none.
fn access(url: &Url, own_host: Option<&str>) -> Option<bool> {
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    let host = url.host_str()?;
    let with_port = match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_string(),
    };
    if own_host == Some(with_port.as_str()) {
        return Some(true);
    }
    let public = host == "gitlab.com"
        || host.ends_with(".gitlab-static.net")
        || host == "secure.gravatar.com"
        || host == "www.gravatar.com";
    public.then_some(false)
}

/// `image/png` and the like, and nothing that could break out of a `data:` address.
fn image_kind(content_type: &str) -> Option<String> {
    let kind = content_type.split(';').next()?.trim().to_ascii_lowercase();
    let plain = kind
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '+' | '.' | '-'));
    (kind.starts_with("image/") && plain).then_some(kind)
}

pub async fn image(data_dir: &Path, input: ImageRef) -> GitlabResult<String> {
    let refused = || GitlabError::BadArg("that is not an image GitLab serves".into());
    let url = Url::parse(&input.url).map_err(|_| refused())?;
    let session = Session::current(data_dir).await.ok();
    let own_host = session
        .as_ref()
        .map(|session| session.account.host.as_str());
    let mut request = client::http()?.get(url.clone());
    if access(&url, own_host).ok_or_else(refused)? {
        if let Some(session) = &session {
            request = client::authorize(request, &session.token);
        }
    }
    let response = client::limited(request.send()).await?;
    let status = response.status();
    if !status.is_success() {
        return Err(client::classify(status, &[]));
    }
    let kind = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .and_then(image_kind)
        .ok_or_else(|| GitlabError::Response("that address is not an image".into()))?;
    let (bytes, _) = client::read_body(response, MAX_IMAGE_BYTES, false).await?;
    Ok(format!(
        "data:{kind};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&bytes)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allowed(raw: &str, own: Option<&str>) -> Option<bool> {
        access(&Url::parse(raw).expect("parses"), own)
    }

    #[test]
    fn the_token_only_goes_to_the_accounts_own_server() {
        let own = Some("gitlab.acme.dev");
        assert_eq!(
            allowed(
                "https://gitlab.acme.dev/uploads/-/system/user/avatar/3/a.png",
                own
            ),
            Some(true)
        );
        assert_eq!(
            allowed(
                "https://gitlab.com/uploads/-/system/user/avatar/3/a.png",
                own
            ),
            Some(false)
        );
        assert_eq!(
            allowed("https://secure.gravatar.com/avatar/abc", own),
            Some(false)
        );
        assert_eq!(
            allowed("https://gitlab.com/uploads/a.png", Some("gitlab.com")),
            Some(true)
        );
    }

    #[test]
    fn anywhere_else_is_refused() {
        for raw in [
            "http://gitlab.com/a.png",
            "https://evil.example/a.png",
            "https://gitlab.acme.dev.evil.example/a.png",
            "https://user:pw@gitlab.com/a.png",
        ] {
            assert_eq!(allowed(raw, Some("gitlab.acme.dev")), None, "{raw}");
        }
    }
}

//! People's pictures beside their names. The window only draws images the app holds itself,
//! so each is fetched here and handed over as a `data:` address.

use base64::Engine;
use reqwest::{StatusCode, Url};
use serde::Deserialize;

use crate::client;
use crate::error::{JiraError, JiraResult};

const MAX_IMAGE_BYTES: usize = 2 * 1024 * 1024;
/// Gravatar sends a person without a picture of their own on to Atlassian's drawn initials,
/// through its image proxy.
const MAX_REDIRECTS: usize = 3;

#[derive(Deserialize)]
pub struct ImageRef {
    pub url: String,
}

/// Avatars live on Gravatar's and Atlassian's public hosts, and Gravatar's image proxy at
/// `i0.wp.com` to `i3.wp.com`; nothing is sent with them.
fn allowed(url: &Url) -> bool {
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    url.host_str().is_some_and(|host| {
        host == "secure.gravatar.com"
            || matches!(host, "i0.wp.com" | "i1.wp.com" | "i2.wp.com" | "i3.wp.com")
            || host.ends_with(".atl-paas.net")
            || host.ends_with(".atlassian.com")
            || host.ends_with(".atlassian.net")
    })
}

/// `image/png` and the like, and nothing that could break out of a `data:` address.
fn image_kind(content_type: &str) -> Option<String> {
    let kind = content_type.split(';').next()?.trim().to_ascii_lowercase();
    let plain = kind
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '+' | '.' | '-'));
    (kind.starts_with("image/") && plain).then_some(kind)
}

pub async fn image(input: ImageRef) -> JiraResult<String> {
    let refused = || JiraError::BadArg("that is not an avatar Jira serves".into());
    let mut url = Url::parse(&input.url).map_err(|_| refused())?;
    for _ in 0..=MAX_REDIRECTS {
        if !allowed(&url) {
            return Err(refused());
        }
        let response = client::http()?.get(url.clone()).send().await?;
        let status = response.status();
        if status.is_redirection() {
            let next = response
                .headers()
                .get("location")
                .and_then(|value| value.to_str().ok())
                .ok_or_else(refused)?;
            url = url.join(next).map_err(|_| refused())?;
            continue;
        }
        if status != StatusCode::OK {
            return Err(JiraError::Http {
                status: status.as_u16(),
                message: "the avatar did not load".into(),
            });
        }
        let kind = response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .and_then(image_kind)
            .ok_or_else(|| JiraError::Response("that address is not an image".into()))?;
        if response
            .content_length()
            .is_some_and(|size| size > MAX_IMAGE_BYTES as u64)
        {
            return Err(JiraError::Response("that avatar is too big".into()));
        }
        let bytes = client::read_limited(response).await?;
        if bytes.len() > MAX_IMAGE_BYTES {
            return Err(JiraError::Response("that avatar is too big".into()));
        }
        return Ok(format!(
            "data:{kind};base64,{}",
            base64::engine::general_purpose::STANDARD.encode(&bytes)
        ));
    }
    Err(JiraError::Response(
        "the avatar redirected too many times".into(),
    ))
}

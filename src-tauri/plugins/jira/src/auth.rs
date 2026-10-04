use std::path::Path;

use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::client::{self, Credentials};
use crate::config::{self, normalise_host, Site};
use crate::error::{JiraError, JiraResult};

/// Who is asking, on the site named or the default one.
pub async fn credentials(data_dir: &Path, host: Option<&str>) -> JiraResult<(Site, Credentials)> {
    let site = config::load(data_dir).site(host)?.clone();
    let kept = site.clone();
    let token = config::blocking(Box::new(move || config::keychain_read(&kept)))
        .await?
        .ok_or(JiraError::Unconfigured)?;
    let credentials = Credentials {
        url: site.url(),
        email: site.email.clone(),
        token,
    };
    Ok((site, credentials))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignIn {
    pub site: String,
    pub email: String,
    pub token: String,
}

/// Checks the email and API token against the site, then keeps the token in the Keychain.
pub async fn sign_in(data_dir: &Path, request: SignIn) -> JiraResult<()> {
    let host = normalise_host(&request.site);
    if host.is_empty() || !host.contains('.') {
        return Err(JiraError::BadArg(
            "the site looks like acme.atlassian.net".into(),
        ));
    }
    let email = request.email.trim().to_string();
    let token = request.token.trim().to_string();
    if email.is_empty() || token.is_empty() {
        return Err(JiraError::BadArg(
            "an email and an API token are both needed".into(),
        ));
    }
    let credentials = Credentials {
        url: format!("https://{host}"),
        email: email.clone(),
        token: token.clone(),
    };
    let me = client::send(&credentials, Method::GET, "/rest/api/3/myself", &[], None).await?;
    let account_id = me
        .get("accountId")
        .and_then(Value::as_str)
        .ok_or_else(|| JiraError::Response("Jira did not say who is signed in".into()))?
        .to_string();
    let site = Site {
        host,
        email,
        account_id,
        display_name: me
            .get("displayName")
            .and_then(Value::as_str)
            .map(str::to_string),
    };
    let kept = site.clone();
    config::blocking(Box::new(move || config::keychain_write(&kept, &token))).await?;
    let mut saved = config::load(data_dir);
    saved.upsert(site);
    config::save(data_dir, &saved)
}

#[derive(Deserialize)]
pub struct SignOut {
    pub site: String,
}

pub async fn sign_out(data_dir: &Path, request: SignOut) -> JiraResult<()> {
    let mut saved = config::load(data_dir);
    let Some(site) = saved.remove(&normalise_host(&request.site)) else {
        return Ok(());
    };
    config::save(data_dir, &saved)?;
    config::blocking(Box::new(move || config::keychain_delete(&site))).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteStatus {
    pub host: String,
    pub email: String,
    pub display_name: Option<String>,
    pub default: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub configured: bool,
    pub sites: Vec<SiteStatus>,
    /// Whether the default site still takes its token; false with `authFailed` when it was revoked.
    pub ok: bool,
    pub auth_failed: bool,
    pub message: Option<String>,
}

pub async fn status(data_dir: &Path) -> Status {
    let saved = config::load(data_dir);
    let sites = saved
        .sites
        .iter()
        .map(|site| SiteStatus {
            host: site.host.clone(),
            email: site.email.clone(),
            display_name: site.display_name.clone(),
            default: saved.default.as_deref() == Some(site.host.as_str()),
        })
        .collect::<Vec<_>>();
    let probe = match credentials(data_dir, None).await {
        Ok((_, credentials)) => {
            client::send(&credentials, Method::GET, "/rest/api/3/myself", &[], None)
                .await
                .map(|_| ())
        }
        Err(error) => Err(error),
    };
    let (ok, auth_failed, message) = match probe {
        Ok(()) => (true, false, None),
        Err(error) => {
            let auth_failed = matches!(
                error,
                JiraError::Unconfigured
                    | JiraError::Auth(_)
                    | JiraError::Http {
                        status: 401 | 403,
                        ..
                    }
            );
            (
                false,
                auth_failed,
                (!sites.is_empty()).then(|| error.to_string()),
            )
        }
    };
    Status {
        configured: !sites.is_empty(),
        sites,
        ok,
        auth_failed,
        message,
    }
}

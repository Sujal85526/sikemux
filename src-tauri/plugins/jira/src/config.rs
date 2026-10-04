// The Jira Cloud sites signed in here. Each site's API token lives in the
// Keychain; the file beside it only lists the sites, who is signed in to each,
// and which one to use when none is named.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{JiraError, JiraResult};

#[cfg(not(test))]
const TOKEN_SERVICE: &str = "sikemux-jira-token";
/// Tests keep to an entry of their own, so they never replace or delete a real token.
#[cfg(test)]
const TOKEN_SERVICE: &str = "sikemux-jira-token-test";

#[derive(Serialize, Deserialize, Clone, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Site {
    /// The site's host, e.g. `acme.atlassian.net`, which also names it to tools.
    pub host: String,
    pub email: String,
    pub account_id: String,
    #[serde(default)]
    pub display_name: Option<String>,
}

impl Site {
    pub fn url(&self) -> String {
        format!("https://{}", self.host)
    }

    fn keychain_account(&self) -> String {
        format!("{}:{}", self.host, self.email)
    }
}

#[derive(Serialize, Deserialize, Clone, Default, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct JiraConfig {
    #[serde(default)]
    pub sites: Vec<Site>,
    /// The site used when a call names none.
    #[serde(default)]
    pub default: Option<String>,
}

impl JiraConfig {
    /// The site named by host, or with none named, the default one.
    pub fn site(&self, host: Option<&str>) -> JiraResult<&Site> {
        let wanted = host.map(normalise_host).or_else(|| self.default.clone());
        let found = match &wanted {
            Some(wanted) => self.sites.iter().find(|site| &site.host == wanted),
            None => self.sites.first(),
        };
        match (found, wanted) {
            (Some(site), _) => Ok(site),
            (None, Some(wanted)) if !self.sites.is_empty() => Err(JiraError::NotFound(format!(
                "jira: {wanted} is not signed in"
            ))),
            _ => Err(JiraError::Unconfigured),
        }
    }

    /// Adds the site, or replaces the one on the same host. The first site becomes the default.
    pub fn upsert(&mut self, site: Site) {
        match self.sites.iter_mut().find(|kept| kept.host == site.host) {
            Some(kept) => *kept = site,
            None => self.sites.push(site),
        }
        let default_is_signed_in = self
            .default
            .as_ref()
            .is_some_and(|host| self.sites.iter().any(|site| &site.host == host));
        if !default_is_signed_in {
            self.default = self.sites.first().map(|site| site.host.clone());
        }
    }

    /// Takes the site out; a removed default passes to the first site left.
    pub fn remove(&mut self, host: &str) -> Option<Site> {
        let index = self.sites.iter().position(|site| site.host == host)?;
        let removed = self.sites.remove(index);
        if self.default.as_deref() == Some(host) {
            self.default = self.sites.first().map(|site| site.host.clone());
        }
        Some(removed)
    }
}

/// `https://Acme.atlassian.net/jira/…` and `acme.atlassian.net` name the same site.
pub fn normalise_host(given: &str) -> String {
    let trimmed = given.trim();
    let without_scheme = trimmed
        .strip_prefix("https://")
        .or_else(|| trimmed.strip_prefix("http://"))
        .unwrap_or(trimmed);
    without_scheme
        .split('/')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase()
}

fn config_path(data_dir: &Path) -> PathBuf {
    data_dir.join("config.json")
}

pub fn load(data_dir: &Path) -> JiraConfig {
    std::fs::read(config_path(data_dir))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn io_error(error: std::io::Error) -> JiraError {
    JiraError::Transport(format!("saving settings: {error}"))
}

pub fn save(data_dir: &Path, config: &JiraConfig) -> JiraResult<()> {
    std::fs::create_dir_all(data_dir).map_err(io_error)?;
    let path = config_path(data_dir);
    let staged = path.with_extension("json.tmp");
    std::fs::write(&staged, serde_json::to_vec_pretty(config)?).map_err(io_error)?;
    std::fs::rename(&staged, &path).map_err(io_error)
}

fn keychain_error(error: sikemux_keychain::KeychainError) -> JiraError {
    match error {
        sikemux_keychain::KeychainError::Invalid(message) => JiraError::BadArg(message),
        sikemux_keychain::KeychainError::Failed(message) => JiraError::Keychain(message),
    }
}

pub fn keychain_read(site: &Site) -> JiraResult<Option<String>> {
    sikemux_keychain::read(TOKEN_SERVICE, &site.keychain_account()).map_err(keychain_error)
}

pub fn keychain_write(site: &Site, token: &str) -> JiraResult<()> {
    sikemux_keychain::write(TOKEN_SERVICE, &site.keychain_account(), token).map_err(keychain_error)
}

pub fn keychain_delete(site: &Site) -> JiraResult<()> {
    sikemux_keychain::delete(TOKEN_SERVICE, &site.keychain_account()).map_err(keychain_error)
}

/// Runs Keychain work on a thread meant for blocking, away from the few threads every plugin shares.
pub async fn blocking<T: Send + 'static>(
    work: Box<dyn FnOnce() -> JiraResult<T> + Send>,
) -> JiraResult<T> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| JiraError::Keychain(error.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn site(host: &str) -> Site {
        Site {
            host: host.into(),
            email: "me@example.com".into(),
            account_id: "1".into(),
            display_name: None,
        }
    }

    #[test]
    fn a_site_is_named_by_its_host_however_it_is_written() {
        assert_eq!(
            normalise_host("https://Acme.atlassian.net/jira/software"),
            "acme.atlassian.net"
        );
        assert_eq!(normalise_host(" acme.atlassian.net "), "acme.atlassian.net");
    }

    #[test]
    fn the_first_site_is_the_default_until_it_goes() {
        let mut config = JiraConfig::default();
        assert!(matches!(config.site(None), Err(JiraError::Unconfigured)));
        config.upsert(site("a.atlassian.net"));
        config.upsert(site("b.atlassian.net"));
        assert_eq!(
            config.site(None).map(|site| site.host.clone()).ok(),
            Some("a.atlassian.net".into())
        );
        assert_eq!(
            config
                .site(Some("https://B.atlassian.net"))
                .map(|site| site.host.clone())
                .ok(),
            Some("b.atlassian.net".into())
        );
        assert!(matches!(
            config.site(Some("c.atlassian.net")),
            Err(JiraError::NotFound(_))
        ));
        config.remove("a.atlassian.net");
        assert_eq!(config.default.as_deref(), Some("b.atlassian.net"));
    }
}

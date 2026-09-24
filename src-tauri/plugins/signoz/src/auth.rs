use std::path::Path;
use std::sync::Mutex as StdMutex;
use std::time::{Duration, Instant};

use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::Mutex;

use crate::client;
use crate::config::{self, AuthMode, SignozConfig, API_KEY_SERVICE, SESSION_SERVICE};
use crate::error::{SignozError, SignozResult};

/// Renew a little before SigNoz would refuse the token, not after.
const RENEW_BEFORE_EXPIRY: Duration = Duration::from_secs(30);
const ASSUMED_LIFETIME: Duration = Duration::from_secs(10 * 60);

#[derive(Clone)]
pub enum Auth {
    None,
    ApiKey(String),
    Bearer(String),
}

#[derive(Clone)]
pub struct Credentials {
    pub url: String,
    pub auth: Auth,
}

impl Credentials {
    pub fn anonymous(url: &str) -> Self {
        Self {
            url: url.to_string(),
            auth: Auth::None,
        }
    }

    pub fn is_session(&self) -> bool {
        matches!(self.auth, Auth::Bearer(_))
    }
}

struct Access {
    url: String,
    token: String,
    renew_at: Instant,
}

/// One renewal at a time: a refresh token is spent when it is used, so two
/// requests renewing together would sign the second one out.
static ACCESS: Mutex<Option<Access>> = Mutex::const_new(None);
static API_KEY: StdMutex<Option<(String, String)>> = StdMutex::new(None);

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> SignozResult<T> + Send + 'static,
) -> SignozResult<T> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| SignozError::Keychain(error.to_string()))?
}

pub async fn load(data_dir: &Path) -> SignozResult<SignozConfig> {
    let data_dir = data_dir.to_path_buf();
    blocking(move || Ok(config::load(&data_dir))).await
}

pub async fn credentials(data_dir: &Path) -> SignozResult<Credentials> {
    let config = load(data_dir).await?;
    if config.url.is_empty() {
        return Err(SignozError::Unconfigured);
    }
    if let Some(key) = config::env_api_key() {
        return Ok(Credentials {
            url: config.url,
            auth: Auth::ApiKey(key),
        });
    }
    if config.account.is_empty() {
        return Err(SignozError::Unconfigured);
    }
    match config.auth {
        AuthMode::ApiKey => api_key(config).await,
        AuthMode::Session => session(config).await,
    }
}

async fn api_key(config: SignozConfig) -> SignozResult<Credentials> {
    if let Some((account, key)) = API_KEY
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
    {
        if account == config.account {
            return Ok(Credentials {
                url: config.url,
                auth: Auth::ApiKey(key),
            });
        }
    }
    let account = config.account.clone();
    let key = blocking(move || config::keychain_read(API_KEY_SERVICE, &account))
        .await?
        .ok_or(SignozError::Unconfigured)?;
    *API_KEY
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) =
        Some((config.account.clone(), key.clone()));
    Ok(Credentials {
        url: config.url,
        auth: Auth::ApiKey(key),
    })
}

async fn session(config: SignozConfig) -> SignozResult<Credentials> {
    let mut access = ACCESS.lock().await;
    if let Some(current) = access.as_ref() {
        if current.url == config.url && Instant::now() < current.renew_at {
            return Ok(Credentials {
                url: config.url,
                auth: Auth::Bearer(current.token.clone()),
            });
        }
    }
    let account = config.account.clone();
    let refresh = blocking(move || config::keychain_read(SESSION_SERVICE, &account))
        .await?
        .ok_or(SignozError::Unconfigured)?;
    let renewed = client::send(
        &Credentials::anonymous(&config.url),
        Method::POST,
        "/api/v2/sessions/rotate",
        Some(&json!({ "refreshToken": refresh })),
    )
    .await
    .map_err(|error| match error {
        SignozError::Http {
            status: 401 | 403, ..
        } => SignozError::Auth("your SigNoz session ended; sign in again".into()),
        other => other,
    })?;
    let tokens = Tokens::from_answer(&renewed)?;
    remember(&mut access, &config, tokens).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Tokens {
    access_token: String,
    refresh_token: String,
    #[serde(default)]
    expires_in: u64,
}

impl Tokens {
    fn from_answer(answer: &Value) -> SignozResult<Self> {
        let body = answer.get("data").unwrap_or(answer);
        Ok(serde_json::from_value(body.clone())?)
    }
}

async fn remember(
    access: &mut Option<Access>,
    config: &SignozConfig,
    tokens: Tokens,
) -> SignozResult<Credentials> {
    let (account, refresh) = (config.account.clone(), tokens.refresh_token.clone());
    blocking(move || config::keychain_write(SESSION_SERVICE, &account, &refresh)).await?;
    let lifetime = if tokens.expires_in == 0 {
        ASSUMED_LIFETIME
    } else {
        Duration::from_secs(tokens.expires_in)
    };
    *access = Some(Access {
        url: config.url.clone(),
        token: tokens.access_token.clone(),
        renew_at: Instant::now() + lifetime.saturating_sub(RENEW_BEFORE_EXPIRY),
    });
    Ok(Credentials {
        url: config.url.clone(),
        auth: Auth::Bearer(tokens.access_token),
    })
}

pub async fn forget_access() {
    *ACCESS.lock().await = None;
}

pub fn forget_api_key() {
    *API_KEY
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Inspect {
    pub url: String,
    pub email: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SsoProvider {
    pub provider: String,
    pub url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgSignIn {
    pub id: String,
    pub name: String,
    pub password: bool,
    pub sso: Vec<SsoProvider>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inspection {
    pub url: String,
    pub version: Option<String>,
    /// Filled in once an email is given: whether SigNoz knows it, and how its orgs let it in.
    pub account_exists: Option<bool>,
    pub orgs: Vec<OrgSignIn>,
}

fn orgs_of(context: &Value) -> Vec<OrgSignIn> {
    let empty = Vec::new();
    let orgs = context
        .pointer("/data/orgs")
        .and_then(Value::as_array)
        .unwrap_or(&empty);
    orgs.iter()
        .filter_map(|org| {
            let support = org.get("authNSupport")?;
            Some(OrgSignIn {
                id: org.get("id")?.as_str()?.to_string(),
                name: org
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                password: support
                    .get("password")
                    .and_then(Value::as_array)
                    .is_some_and(|ways| !ways.is_empty()),
                sso: support
                    .get("callback")
                    .and_then(|callback| serde_json::from_value(callback.clone()).ok())
                    .unwrap_or_default(),
            })
        })
        .collect()
}

/// Everything the sign-in screen can learn before anyone has a credential.
/// An address that answers is remembered, and so is the email typed for it.
pub async fn inspect(data_dir: &Path, request: Inspect) -> SignozResult<Inspection> {
    let url = config::validate_url(&request.url)?;
    let anonymous = Credentials::anonymous(&url);
    let version = client::send(&anonymous, Method::GET, "/api/v1/version", None)
        .await?
        .get("version")
        .and_then(Value::as_str)
        .map(str::to_string);
    remember_address(data_dir, &url, None).await?;
    let Some(email) = request
        .email
        .as_deref()
        .map(str::trim)
        .filter(|email| !email.is_empty())
    else {
        return Ok(Inspection {
            url,
            version,
            account_exists: None,
            orgs: Vec::new(),
        });
    };
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("email", email)
        .append_pair("ref", &url)
        .finish();
    let context = client::send(
        &anonymous,
        Method::GET,
        &format!("/api/v2/sessions/context?{query}"),
        None,
    )
    .await?;
    remember_address(data_dir, &url, Some(email)).await?;
    Ok(Inspection {
        account_exists: context.pointer("/data/exists").and_then(Value::as_bool),
        orgs: orgs_of(&context),
        url,
        version,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignIn {
    pub url: String,
    pub email: String,
    pub password: String,
    /// Needed only when the email belongs to more than one org.
    pub org_id: Option<String>,
}

pub async fn sign_in(data_dir: &Path, request: SignIn) -> SignozResult<()> {
    let url = config::validate_url(&request.url)?;
    let email = request.email.trim().to_string();
    let org_id = match request.org_id.filter(|id| !id.is_empty()) {
        Some(id) => id,
        None => {
            let inspection = inspect(
                data_dir,
                Inspect {
                    url: url.clone(),
                    email: Some(email.clone()),
                },
            )
            .await?;
            let mut password_orgs = inspection.orgs.into_iter().filter(|org| org.password);
            match (password_orgs.next(), password_orgs.next()) {
                (Some(org), None) => org.id,
                (None, _) => {
                    return Err(SignozError::Auth(
                        "this SigNoz does not take a password for that email".into(),
                    ))
                }
                (Some(_), Some(_)) => {
                    return Err(SignozError::BadArg(
                        "that email is in more than one organisation; choose one".into(),
                    ))
                }
            }
        }
    };
    let answer = client::send(
        &Credentials::anonymous(&url),
        Method::POST,
        "/api/v2/sessions/email_password",
        Some(&json!({ "email": email, "password": request.password, "orgId": org_id })),
    )
    .await
    .map_err(|error| match error {
        SignozError::Http {
            status: 400 | 401 | 403,
            message,
        } => SignozError::Auth(message),
        other => other,
    })?;
    let tokens = Tokens::from_answer(&answer)?;
    let config = SignozConfig {
        account: config::account_for(&url),
        url,
        auth: AuthMode::Session,
        email,
        owns_key: false,
    };
    let mut access = ACCESS.lock().await;
    remember(&mut access, &config, tokens).await?;
    drop(access);
    save(data_dir, config).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UseApiKey {
    pub url: String,
    /// Left out to use a key the Keychain already holds under `account`.
    pub api_key: Option<String>,
    pub account: Option<String>,
}

pub async fn use_api_key(data_dir: &Path, request: UseApiKey) -> SignozResult<()> {
    let url = config::validate_url(&request.url)?;
    let account = match request
        .account
        .as_deref()
        .map(str::trim)
        .filter(|account| !account.is_empty())
    {
        Some(account) => config::validate_account(account)?,
        None => config::account_for(&url),
    };
    let given = request
        .api_key
        .map(|key| key.trim().to_string())
        .filter(|key| !key.is_empty());
    let key = match given.clone() {
        Some(key) => key,
        None => {
            let account = account.clone();
            blocking(move || config::keychain_read(API_KEY_SERVICE, &account))
                .await?
                .ok_or_else(|| {
                    SignozError::Auth(format!(
                        "the Keychain has no SigNoz key for {}",
                        config::account_for(&url)
                    ))
                })?
        }
    };
    client::check(&Credentials {
        url: url.clone(),
        auth: Auth::ApiKey(key.clone()),
    })
    .await?;
    if given.is_some() {
        let (account, key) = (account.clone(), key.clone());
        blocking(move || config::keychain_write(API_KEY_SERVICE, &account, &key)).await?;
    }
    forget_api_key();
    let config = SignozConfig {
        owns_key: given.is_some(),
        url,
        auth: AuthMode::ApiKey,
        account,
        email: String::new(),
    };
    save(data_dir, config).await
}

async fn save(data_dir: &Path, config: SignozConfig) -> SignozResult<()> {
    let data_dir = data_dir.to_path_buf();
    blocking(move || config::save(&data_dir, &config)).await
}

/// Ends the session on SigNoz's side too, and removes only the Keychain entries Sikemux made.
pub async fn sign_out(data_dir: &Path) -> SignozResult<()> {
    let config = load(data_dir).await?;
    if config.auth == AuthMode::Session {
        if let Some(current) = ACCESS.lock().await.take() {
            let credentials = Credentials {
                url: config.url.clone(),
                auth: Auth::Bearer(current.token),
            };
            let _ = client::send(&credentials, Method::DELETE, "/api/v2/sessions", None).await;
        }
    }
    forget_api_key();
    let data_dir = data_dir.to_path_buf();
    blocking(move || {
        match config.auth {
            AuthMode::Session if !config.account.is_empty() => {
                config::keychain_delete(SESSION_SERVICE, &config.account)?
            }
            AuthMode::ApiKey if config.owns_key => {
                config::keychain_delete(API_KEY_SERVICE, &config.account)?
            }
            _ => {}
        }
        config::save(&data_dir, &signed_out(config))
    })
    .await
}

/// Where SigNoz is and who last signed in outlive the credential, so the
/// next sign-in starts from them instead of a blank form.
fn signed_out(config: SignozConfig) -> SignozConfig {
    SignozConfig {
        account: String::new(),
        owns_key: false,
        ..config
    }
}

/// Keeps an address that answered, and the email typed for it. A new
/// address drops the old credential, which belongs to the old address.
async fn remember_address(data_dir: &Path, url: &str, email: Option<&str>) -> SignozResult<()> {
    let mut config = load(data_dir).await?;
    if config.url != url {
        config = signed_out(SignozConfig {
            url: url.to_string(),
            ..config
        });
    }
    if let Some(email) = email {
        config.email = email.to_string();
    }
    save(data_dir, config).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_how_each_org_lets_an_email_in() {
        let context = json!({ "status": "success", "data": { "exists": true, "orgs": [
            { "id": "org-1", "name": "", "authNSupport": { "callback": [], "password": [{ "provider": "email_password" }] } },
            { "id": "org-2", "name": "Acme", "authNSupport": { "callback": [{ "provider": "google", "url": "https://sso.example.com" }], "password": [] } },
        ] } });
        let orgs = orgs_of(&context);
        assert_eq!(orgs.len(), 2);
        assert!(orgs[0].password && orgs[0].sso.is_empty());
        assert!(!orgs[1].password);
        assert_eq!(orgs[1].sso[0].provider, "google");
    }

    #[test]
    fn reads_tokens_with_or_without_the_data_envelope() {
        let wrapped = json!({ "status": "success", "data": { "tokenType": "Bearer", "accessToken": "a", "refreshToken": "r", "expiresIn": 3600 } });
        let bare = json!({ "accessToken": "a", "refreshToken": "r" });
        assert_eq!(Tokens::from_answer(&wrapped).unwrap().expires_in, 3600);
        assert_eq!(Tokens::from_answer(&bare).unwrap().expires_in, 0);
    }

    #[tokio::test]
    async fn keeps_the_address_but_never_carries_a_credential_to_another() {
        let dir =
            std::env::temp_dir().join(format!("sikemux-signoz-address-{}", std::process::id()));
        let signed_in = SignozConfig {
            url: "https://a.example.com".into(),
            auth: AuthMode::Session,
            account: "a.example.com".into(),
            email: "me@example.com".into(),
            owns_key: false,
        };
        config::save(&dir, &signed_in).unwrap();

        remember_address(&dir, "https://a.example.com", None)
            .await
            .unwrap();
        assert_eq!(config::load(&dir).account, "a.example.com");

        remember_address(&dir, "https://b.example.com", Some("other@example.com"))
            .await
            .unwrap();
        let moved = config::load(&dir);
        assert_eq!(moved.url, "https://b.example.com");
        assert_eq!(moved.email, "other@example.com");
        assert_eq!(moved.account, "");
        assert!(matches!(
            credentials(&dir).await,
            Err(SignozError::Unconfigured)
        ));

        config::save(&dir, &signed_out(signed_in)).unwrap();
        let after_sign_out = config::load(&dir);
        assert_eq!(
            (after_sign_out.url.as_str(), after_sign_out.email.as_str()),
            ("https://a.example.com", "me@example.com")
        );
        std::fs::remove_dir_all(dir).ok();
    }
}

//! Where agents get models besides their makers' own accounts: pay-per-token APIs,
//! coding plans and runners on this computer. The catalogue in `model-providers.json`
//! holds every provider's facts. Connecting a keyed provider saves its key in the
//! Keychain and hands it to OpenCode, Pi and OMP as they start.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{LazyLock, OnceLock};
use std::time::Duration;

use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use sikemux_core::launch::providers::{Providers, KEY_SERVICE};

const CHECK_TIMEOUT: Duration = Duration::from_secs(15);
const RUNNER_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Deserialize, Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum Kind {
    Api,
    Plan,
    Local,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Provider {
    id: String,
    label: String,
    kind: Kind,
    sign_up_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    key: Option<KeySpec>,
    /// Base URL of its OpenAI-compatible API.
    openai: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    anthropic: Option<AnthropicApi>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct KeySpec {
    /// Every name an agent looks for this key under.
    env: Vec<String>,
    /// Answers 401 or 403 to a key the provider does not know.
    check: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct AnthropicApi {
    url: String,
    auth: AnthropicAuth,
}

/// How the Anthropic-compatible API wants the key: Claude Code sends
/// `ANTHROPIC_AUTH_TOKEN` as a bearer token and `ANTHROPIC_API_KEY` as `x-api-key`.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
enum AnthropicAuth {
    Bearer,
    XApiKey,
}

static CATALOGUE: LazyLock<Vec<Provider>> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../model-providers.json"))
        .expect("model-providers.json is a valid catalogue")
});

fn keyed(id: &str) -> Result<(&'static Provider, &'static KeySpec), String> {
    let provider = CATALOGUE
        .iter()
        .find(|provider| provider.id == id)
        .ok_or_else(|| format!("Sikemux does not know a provider called {id}"))?;
    let key = provider
        .key
        .as_ref()
        .ok_or_else(|| format!("{} runs on this computer and needs no key", provider.label))?;
    Ok((provider, key))
}

#[derive(Serialize)]
pub struct ModelProvider {
    #[serde(flatten)]
    provider: &'static Provider,
    /// A keyed provider has its key saved; a local runner is answering.
    connected: bool,
    /// What a running local runner has installed.
    #[serde(skip_serializing_if = "Option::is_none")]
    models: Option<Vec<String>>,
}

static STORE: OnceLock<Providers> = OnceLock::new();

pub fn init(data_dir: &Path) {
    let _ = STORE.set(Providers::new(data_dir));
}

fn store() -> Result<&'static Providers, String> {
    STORE
        .get()
        .ok_or_else(|| "Model providers are not ready yet".to_string())
}

/// The keys `agent` should start with, under the names it looks for.
pub async fn environment(agent: &str) -> BTreeMap<String, String> {
    let Ok(store) = store() else {
        return BTreeMap::new();
    };
    let agent = agent.to_owned();
    tokio::task::spawn_blocking(move || store.environment(&agent))
        .await
        .unwrap_or_default()
}

fn client() -> &'static Client {
    static CLIENT: OnceLock<Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        Client::builder()
            .timeout(CHECK_TIMEOUT)
            .user_agent(concat!("sikemux/", env!("CARGO_PKG_VERSION")))
            .build()
            .unwrap_or_default()
    })
}

fn check_failure(label: &str, status: StatusCode) -> Option<String> {
    match status {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
            Some(format!("{label} did not accept that key"))
        }
        status if status.is_success() => None,
        status => Some(format!(
            "{label} could not check the key right now ({status})"
        )),
    }
}

async fn check_key(provider: &Provider, spec: &KeySpec, key: &str) -> Result<(), String> {
    let response = client()
        .get(&spec.check)
        .bearer_auth(key)
        .send()
        .await
        .map_err(|_| format!("Could not reach {} to check the key", provider.label))?;
    match check_failure(&provider.label, response.status()) {
        Some(failure) => Err(failure),
        None => Ok(()),
    }
}

#[derive(Deserialize)]
struct ModelList {
    data: Vec<ListedModel>,
}

#[derive(Deserialize)]
struct ListedModel {
    id: String,
}

/// `None` when nothing answers at the runner's address.
async fn local_models(provider: &Provider) -> Option<Vec<String>> {
    let response = client()
        .get(format!("{}/models", provider.openai))
        .timeout(RUNNER_TIMEOUT)
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?;
    let list: ModelList = response.json().await.ok()?;
    Some(list.data.into_iter().map(|model| model.id).collect())
}

/// Local runners are asked what they have on every call, so only when settings ask.
#[tauri::command]
pub async fn model_providers() -> Vec<ModelProvider> {
    let saved = store().map(Providers::connected).unwrap_or_default();
    futures::future::join_all(CATALOGUE.iter().map(|provider| {
        let saved = &saved;
        async move {
            let models = match provider.kind {
                Kind::Local => local_models(provider).await,
                Kind::Api | Kind::Plan => None,
            };
            ModelProvider {
                provider,
                connected: models.is_some() || saved.contains(&provider.id),
                models,
            }
        }
    }))
    .await
}

/// Saves the key once the provider accepts it. Agents already running keep
/// the environment they started with.
#[tauri::command]
pub async fn model_provider_connect(id: String, key: String) -> Result<(), String> {
    let (provider, spec) = keyed(&id)?;
    let store = store()?;
    let key = key.trim().to_owned();
    if key.is_empty() {
        return Err("Paste the key first".into());
    }
    check_key(provider, spec, &key).await?;
    let saved = key.clone();
    tokio::task::spawn_blocking(move || sikemux_keychain::write(KEY_SERVICE, &provider.id, &saved))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())?;
    store.remember_key(&provider.id, Some(key));
    store.set_connected(&provider.id, true)
}

#[tauri::command]
pub async fn model_provider_disconnect(id: String) -> Result<(), String> {
    let (provider, _) = keyed(&id)?;
    let store = store()?;
    tokio::task::spawn_blocking(move || sikemux_keychain::delete(KEY_SERVICE, &provider.id))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())?;
    store.remember_key(&provider.id, None);
    store.set_connected(&provider.id, false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    #[test]
    fn every_provider_has_its_own_id_and_key_names() {
        let ids: BTreeSet<_> = CATALOGUE.iter().map(|provider| &provider.id).collect();
        assert_eq!(ids.len(), CATALOGUE.len());
        let envs: Vec<_> = CATALOGUE
            .iter()
            .filter_map(|provider| provider.key.as_ref())
            .flat_map(|spec| &spec.env)
            .collect();
        assert_eq!(envs.iter().collect::<BTreeSet<_>>().len(), envs.len());
        for provider in CATALOGUE.iter() {
            assert_eq!(
                provider.key.is_none(),
                provider.kind == Kind::Local,
                "{}",
                provider.id
            );
            assert!(
                provider.sign_up_url.starts_with("https://"),
                "{}",
                provider.id
            );
            if let Some(spec) = &provider.key {
                assert!(spec.check.starts_with("https://"), "{}", provider.id);
                assert!(!spec.env.is_empty(), "{}", provider.id);
            }
        }
    }

    #[test]
    fn a_rejected_key_is_told_apart_from_a_provider_that_did_not_answer() {
        assert_eq!(check_failure("Baseten", StatusCode::OK), None);
        assert_eq!(
            check_failure("Baseten", StatusCode::FORBIDDEN).as_deref(),
            Some("Baseten did not accept that key")
        );
        assert_eq!(
            check_failure("Groq", StatusCode::UNAUTHORIZED).as_deref(),
            Some("Groq did not accept that key")
        );
        assert!(check_failure("Groq", StatusCode::BAD_GATEWAY)
            .is_some_and(|failure| failure.contains("could not check")));
    }
}

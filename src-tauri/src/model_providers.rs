//! Where agents get models besides their makers' own accounts: pay-per-token APIs,
//! coding plans and runners on this computer. The catalogue in `model-providers.json`
//! holds every provider's facts. Connecting a keyed provider saves its key in the
//! Keychain and hands it to OpenCode, Pi and OMP as they start.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex, OnceLock};
use std::time::Duration;

use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};

/// A development build keeps entries of its own, so it never spends or replaces the
/// installed app's sign-in.
#[cfg(not(test))]
const KEY_SERVICE: &str = if cfg!(debug_assertions) {
    "sikemux-model-provider-dev"
} else {
    "sikemux-model-provider"
};
/// Tests keep to an entry of their own, so they never replace or delete a real key.
#[cfg(test)]
const KEY_SERVICE: &str = "sikemux-model-provider-test";
const CHECK_TIMEOUT: Duration = Duration::from_secs(15);
const RUNNER_TIMEOUT: Duration = Duration::from_secs(2);

/// The agents that read these providers' keys from their environment.
const READERS: &[&str] = &["opencode", "pi", "omp"];

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

/// Which providers have a key saved, and the keys themselves once read, so
/// a launch does not start the Keychain tool for every provider every time.
struct Store {
    path: PathBuf,
    connected: Mutex<BTreeSet<String>>,
    keys: Mutex<HashMap<String, String>>,
}

static STORE: OnceLock<Store> = OnceLock::new();

pub fn init(path: PathBuf) {
    let _ = STORE.set(Store::load(path));
}

fn store() -> Result<&'static Store, String> {
    STORE
        .get()
        .ok_or_else(|| "Model providers are not ready yet".to_string())
}

impl Store {
    fn load(path: PathBuf) -> Self {
        let connected = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<BTreeSet<String>>(&bytes).ok())
            .unwrap_or_default()
            .into_iter()
            .filter(|id| keyed(id).is_ok())
            .collect();
        Self {
            path,
            connected: Mutex::new(connected),
            keys: Mutex::new(HashMap::new()),
        }
    }

    fn connected(&self) -> BTreeSet<String> {
        self.connected
            .lock()
            .map(|connected| connected.clone())
            .unwrap_or_default()
    }

    fn set_connected(&self, id: &str, connected: bool) -> Result<(), String> {
        let mut ids = self
            .connected
            .lock()
            .map_err(|_| "Model providers are unavailable".to_string())?;
        let changed = if connected {
            ids.insert(id.to_owned())
        } else {
            ids.remove(id)
        };
        if !changed {
            return Ok(());
        }
        let bytes = serde_json::to_vec(&*ids).map_err(|error| error.to_string())?;
        sikemux_process::files::write_atomic(&self.path, &bytes, false)
            .map_err(|error| error.to_string())
    }

    fn remember_key(&self, id: &str, key: Option<String>) {
        if let Ok(mut keys) = self.keys.lock() {
            match key {
                Some(key) => keys.insert(id.to_owned(), key),
                None => keys.remove(id),
            };
        }
    }

    fn key(&self, id: &str) -> Option<String> {
        if let Some(key) = self.keys.lock().ok()?.get(id).cloned() {
            return Some(key);
        }
        let key = match sikemux_keychain::read(KEY_SERVICE, id) {
            Ok(key) => key?,
            Err(error) => {
                eprintln!("Sikemux could not read the {id} key: {error}");
                return None;
            }
        };
        self.remember_key(id, Some(key.clone()));
        Some(key)
    }
}

fn reads_provider_keys(agent: &str) -> bool {
    READERS.contains(&agent)
}

/// The keys `agent` should start with, under the names it looks for.
pub async fn environment(agent: &str) -> BTreeMap<String, String> {
    if !reads_provider_keys(agent) {
        return BTreeMap::new();
    }
    let Ok(store) = store() else {
        return BTreeMap::new();
    };
    let connected = store.connected();
    if connected.is_empty() {
        return BTreeMap::new();
    }
    tokio::task::spawn_blocking(move || {
        connected
            .iter()
            .filter_map(|id| Some((keyed(id).ok()?.1, store.key(id)?)))
            .flat_map(|(spec, key)| spec.env.iter().map(move |name| (name.clone(), key.clone())))
            .collect()
    })
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
    let saved = store().map(Store::connected).unwrap_or_default();
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

    #[test]
    fn the_connected_list_survives_a_restart_and_drops_unknown_providers() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("model-providers.json");
        std::fs::write(&path, r#"["baseten","retired-provider"]"#).expect("write list");
        let store = Store::load(path.clone());
        assert_eq!(store.connected(), BTreeSet::from(["baseten".to_string()]));
        store.set_connected("groq", true).expect("connect");
        assert_eq!(
            Store::load(path.clone()).connected(),
            BTreeSet::from(["baseten".to_string(), "groq".to_string()])
        );
        store.set_connected("baseten", false).expect("disconnect");
        assert_eq!(
            std::fs::read_to_string(&path).expect("read list"),
            r#"["groq"]"#
        );
    }
}

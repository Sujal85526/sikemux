//! The keys of the hosted model providers the person connected. They stay in
//! the Keychain, and the agents that read them get them as they start, through
//! the one input every launch takes for them.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex, MutexGuard};
use std::time::SystemTime;

use serde::Deserialize;

/// A development build keeps entries of its own, so it never spends or replaces the
/// installed app's sign-in.
#[cfg(not(test))]
pub const KEY_SERVICE: &str = if cfg!(debug_assertions) {
    "sikemux-model-provider-dev"
} else {
    "sikemux-model-provider"
};
/// Tests keep to an entry of their own, so they never replace or delete a real key.
#[cfg(test)]
pub const KEY_SERVICE: &str = "sikemux-model-provider-test";

/// The agents that read these providers' keys from their environment.
const READERS: &[&str] = &["opencode", "pi", "omp"];

#[derive(Deserialize)]
struct Listed {
    id: String,
    key: Option<KeyNames>,
}

#[derive(Deserialize)]
struct KeyNames {
    env: Vec<String>,
}

/// The names each keyed provider's key goes by, from the app's catalogue.
static KEY_NAMES: LazyLock<HashMap<String, Vec<String>>> = LazyLock::new(|| {
    serde_json::from_str::<Vec<Listed>>(include_str!("../../../../model-providers.json"))
        .expect("model-providers.json is a valid catalogue")
        .into_iter()
        .filter_map(|listed| Some((listed.id, listed.key?.env)))
        .collect()
});

pub fn is_keyed(id: &str) -> bool {
    KEY_NAMES.contains_key(id)
}

/// Which providers have a key saved, kept in a file the app and the core both
/// read, and the keys this process has read, so a launch does not start the
/// Keychain tool for every provider every time.
pub struct Providers {
    path: PathBuf,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    /// When the list was last written, so a change another process made is noticed.
    stamp: Option<SystemTime>,
    connected: BTreeSet<String>,
    keys: HashMap<String, String>,
}

impl Providers {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            path: data_dir.join("model-providers.json"),
            state: Mutex::default(),
        }
    }

    fn fresh(&self) -> MutexGuard<'_, State> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let stamp = std::fs::metadata(&self.path)
            .and_then(|metadata| metadata.modified())
            .ok();
        if stamp != state.stamp || stamp.is_none() {
            state.connected = std::fs::read(&self.path)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<BTreeSet<String>>(&bytes).ok())
                .unwrap_or_default()
                .into_iter()
                .filter(|id| is_keyed(id))
                .collect();
            state.keys.clear();
            state.stamp = stamp;
        }
        state
    }

    pub fn connected(&self) -> BTreeSet<String> {
        self.fresh().connected.clone()
    }

    /// Written even when unchanged, so a process holding a replaced key reads it again.
    pub fn set_connected(&self, id: &str, connected: bool) -> Result<(), String> {
        let mut state = self.fresh();
        if connected {
            state.connected.insert(id.to_owned());
        } else {
            state.connected.remove(id);
        }
        let bytes = serde_json::to_vec(&state.connected).map_err(|error| error.to_string())?;
        sikemux_process::files::write_atomic(&self.path, &bytes, false)
            .map_err(|error| error.to_string())?;
        state.stamp = std::fs::metadata(&self.path)
            .and_then(|metadata| metadata.modified())
            .ok();
        Ok(())
    }

    pub fn remember_key(&self, id: &str, key: Option<String>) {
        let mut state = self.fresh();
        match key {
            Some(key) => state.keys.insert(id.to_owned(), key),
            None => state.keys.remove(id),
        };
    }

    fn key(&self, id: &str) -> Option<String> {
        if let Some(key) = self.fresh().keys.get(id).cloned() {
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

    /// The keys `agent` starts with, under the names it looks for. Reads the
    /// Keychain, so it blocks.
    pub fn environment(&self, agent: &str) -> BTreeMap<String, String> {
        if !READERS.contains(&agent) {
            return BTreeMap::new();
        }
        self.connected()
            .iter()
            .filter_map(|id| Some((KEY_NAMES.get(id)?, self.key(id)?)))
            .flat_map(|(names, key)| names.iter().map(move |name| (name.clone(), key.clone())))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_connected_list_survives_a_restart_and_drops_unknown_providers() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("model-providers.json");
        std::fs::write(&path, r#"["baseten","retired-provider"]"#).expect("write list");
        let store = Providers::new(directory.path());
        assert_eq!(store.connected(), BTreeSet::from(["baseten".to_string()]));
        store.set_connected("groq", true).expect("connect");
        assert_eq!(
            Providers::new(directory.path()).connected(),
            BTreeSet::from(["baseten".to_string(), "groq".to_string()])
        );
        store.set_connected("baseten", false).expect("disconnect");
        assert_eq!(
            std::fs::read_to_string(&path).expect("read list"),
            r#"["groq"]"#
        );
    }
}

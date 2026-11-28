//! Accounts whose provider refused a chat because the plan is unpaid. Each is kept off new
//! chats until a turn goes through on it again, it is signed in as someone else, or a day
//! has passed, across restarts once the core names a file to keep them in.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use sikemux_process::clock::epoch_ms;
use sikemux_process::sync::Locked;

use super::key;
use super::sign_in::{signed_in, SignIn};
use crate::launch::account_environment;

/// How long a refused plan keeps its account off new chats, so a bill paid since is tried again.
const HOLD_MS: u64 = 24 * 60 * 60 * 1000;

/// Who the account was signed in as when its plan was refused, and when.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Refusal {
    signed_in: Option<SignIn>,
    at_ms: u64,
}

#[derive(Default)]
struct Held {
    file: Option<PathBuf>,
    by_account: BTreeMap<String, Refusal>,
}

fn held() -> &'static Mutex<Held> {
    static HELD: OnceLock<Mutex<Held>> = OnceLock::new();
    HELD.get_or_init(Default::default)
}

/// Keeps the unpaid accounts in `file`, taking up what an earlier core kept there along with
/// any refused since this core started.
pub fn keep_in(file: PathBuf) {
    let mut kept = read(&file);
    let mut held = held().locked();
    let refused_since = !held.by_account.is_empty();
    kept.append(&mut held.by_account);
    *held = Held {
        file: Some(file),
        by_account: kept,
    };
    if refused_since {
        save(&held);
    }
}

fn read(file: &Path) -> BTreeMap<String, Refusal> {
    std::fs::read(file)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn save(held: &Held) {
    let Some(file) = &held.file else {
        return;
    };
    let written = serde_json::to_vec(&held.by_account)
        .map_err(std::io::Error::other)
        .and_then(|bytes| sikemux_process::files::write_atomic(file, &bytes, true));
    if let Err(error) = written {
        eprintln!("sikemux core: could not keep the unpaid accounts: {error}");
    }
}

fn sign_in_of(provider: &str, config_path: Option<&str>) -> Option<SignIn> {
    let env: BTreeMap<String, String> = account_environment(provider, config_path)
        .into_iter()
        .collect();
    signed_in(provider, &env)
}

pub fn mark(provider: &str, config_path: Option<&str>) {
    let refusal = Refusal {
        signed_in: sign_in_of(provider, config_path),
        at_ms: epoch_ms(),
    };
    let mut held = held().locked();
    held.by_account.insert(key(provider, config_path), refusal);
    save(&held);
}

pub fn any() -> bool {
    !held().locked().by_account.is_empty()
}

/// Answers whether the account was held as unpaid.
pub fn clear(provider: &str, config_path: Option<&str>) -> bool {
    let mut held = held().locked();
    let cleared = held
        .by_account
        .remove(&key(provider, config_path))
        .is_some();
    if cleared {
        save(&held);
    }
    cleared
}

/// Whether the account is held as unpaid. A sign-in that cannot be read now, such as a file
/// caught halfway through being written, keeps the hold; only another sign-in lifts it early.
pub fn is_unpaid(provider: &str, config_path: Option<&str>) -> bool {
    let key = key(provider, config_path);
    let Some(refusal) = held().locked().by_account.get(&key).cloned() else {
        return false;
    };
    let now = sign_in_of(provider, config_path);
    let signed_in_anew = now.is_some() && refusal.signed_in.is_some() && now != refusal.signed_in;
    let lapsed = epoch_ms().saturating_sub(refusal.at_ms) >= HOLD_MS;
    if !signed_in_anew && !lapsed {
        return true;
    }
    let mut held = held().locked();
    held.by_account.remove(&key);
    save(&held);
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unpaid_account_is_kept_for_the_core_after_a_restart() {
        let data = tempfile::tempdir().expect("data");
        let account = tempfile::tempdir().expect("account");
        let folder = account.path().to_str().expect("folder");
        let file = data.path().join("unpaid-accounts.json");
        keep_in(file.clone());
        mark("claude", Some(folder));

        let kept = read(&file);

        assert!(kept.contains_key(&key("claude", Some(folder))));
    }
}

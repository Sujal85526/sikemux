//! Each agent's secret, which its tool calls carry to show which agent made
//! them. A secret is the core's key signing the agent's id, so the core checks
//! one without keeping a list. The key lives in `<socket>.agents.key`, so an
//! agent started before the core was replaced keeps a secret that still holds.

use std::fs::OpenOptions;
use std::io::{ErrorKind, Read, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

use ring::hmac;
use ring::rand::{SecureRandom, SystemRandom};

use super::CoreResult;

const KEY_BYTES: usize = 32;

pub(crate) struct AgentKey {
    key: RwLock<hmac::Key>,
}

impl Default for AgentKey {
    fn default() -> Self {
        Self {
            key: RwLock::new(hmac::Key::new(hmac::HMAC_SHA256, &random_key())),
        }
    }
}

pub(crate) fn file_path(socket: &Path) -> PathBuf {
    let mut path = socket.as_os_str().to_owned();
    path.push(".agents.key");
    PathBuf::from(path)
}

impl AgentKey {
    /// Takes up the key kept at `path`, writing a new one when there is none.
    pub(crate) fn load(&self, path: &Path) -> CoreResult<()> {
        let bytes = read_or_create(path)?;
        if let Ok(mut key) = self.key.write() {
            *key = hmac::Key::new(hmac::HMAC_SHA256, &bytes);
        }
        Ok(())
    }

    pub(crate) fn secret(&self, agent_id: &str) -> String {
        let key = self
            .key
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        hex::encode(hmac::sign(&key, agent_id.as_bytes()))
    }

    pub(crate) fn proves(&self, agent_id: &str, secret: &str) -> bool {
        let Ok(tag) = hex::decode(secret) else {
            return false;
        };
        let key = self
            .key
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        hmac::verify(&key, agent_id.as_bytes(), &tag).is_ok()
    }
}

fn random_key() -> [u8; KEY_BYTES] {
    let mut bytes = [0u8; KEY_BYTES];
    SystemRandom::new()
        .fill(&mut bytes)
        .expect("the system's random source is unavailable");
    bytes
}

fn read_or_create(path: &Path) -> CoreResult<Vec<u8>> {
    match std::fs::File::open(path) {
        Ok(mut file) => {
            let mut bytes = Vec::new();
            file.read_to_end(&mut bytes)?;
            if bytes.len() == KEY_BYTES {
                return Ok(bytes);
            }
            Err(format!("{} is not an agent key", path.display()).into())
        }
        Err(error) if error.kind() == ErrorKind::NotFound => {
            let bytes = random_key();
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(path)?;
            file.write_all(&bytes)?;
            Ok(bytes.to_vec())
        }
        Err(error) => Err(error.into()),
    }
}

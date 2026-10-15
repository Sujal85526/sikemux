//! Each agent's secret, which its tool calls carry to show which agent made
//! them. A secret is the core's key signing the agent's id, so the core checks
//! one without keeping a list.
//!
//! The key never touches the disk, where any agent could read it and sign
//! another agent's id. Agents die with the core, except across an update,
//! which hands the key to the replacement through a pipe only it inherits.

use std::io::{Read, Write};
use std::os::fd::OwnedFd;
use std::sync::RwLock;

use ring::hmac;
use ring::rand::{SecureRandom, SystemRandom};

use super::CoreResult;

const KEY_BYTES: usize = 32;

pub(crate) struct AgentKey {
    held: RwLock<Held>,
}

struct Held {
    bytes: [u8; KEY_BYTES],
    key: hmac::Key,
}

impl Held {
    fn new(bytes: [u8; KEY_BYTES]) -> Self {
        Self {
            key: hmac::Key::new(hmac::HMAC_SHA256, &bytes),
            bytes,
        }
    }
}

impl Default for AgentKey {
    fn default() -> Self {
        Self {
            held: RwLock::new(Held::new(random_key())),
        }
    }
}

impl AgentKey {
    pub(crate) fn secret(&self, agent_id: &str) -> String {
        let held = self
            .held
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        hex::encode(hmac::sign(&held.key, agent_id.as_bytes()))
    }

    pub(crate) fn proves(&self, agent_id: &str, secret: &str) -> bool {
        let Ok(tag) = hex::decode(secret) else {
            return false;
        };
        let held = self
            .held
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        hmac::verify(&held.key, agent_id.as_bytes(), &tag).is_ok()
    }

    /// The read end of a pipe holding the key, for the core that replaces
    /// this one to take up.
    pub(crate) fn hand_over(&self) -> std::io::Result<OwnedFd> {
        let (reader, mut writer) = std::io::pipe()?;
        let held = self
            .held
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        writer.write_all(&held.bytes)?;
        Ok(reader.into())
    }

    /// Takes up the key the replaced core handed over in `pipe`.
    pub(crate) fn take_over(&self, pipe: OwnedFd) -> CoreResult<()> {
        let mut bytes = [0u8; KEY_BYTES];
        std::fs::File::from(pipe).read_exact(&mut bytes)?;
        let mut held = self
            .held
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *held = Held::new(bytes);
        Ok(())
    }
}

fn random_key() -> [u8; KEY_BYTES] {
    let mut bytes = [0u8; KEY_BYTES];
    SystemRandom::new()
        .fill(&mut bytes)
        .expect("the system's random source is unavailable");
    bytes
}

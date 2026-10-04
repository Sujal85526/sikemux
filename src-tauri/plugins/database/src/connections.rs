// Reaching a database: trying a connection before it is saved, and keeping
// one open per saved database so browsing and queries do not sign in each time.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Instant;

use serde::{Deserialize, Serialize};

use crate::engines::Session;
use crate::error::DatabaseResult;
use crate::profiles::{self, Draft};

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TestRequest {
    pub profile: Draft,
    #[serde(default)]
    pub password: Option<String>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Tested {
    pub version: String,
    pub millis: u64,
}

/// Tries the profile as typed. Editing a saved one without retyping its password uses the saved password.
pub async fn test(data_dir: PathBuf, request: TestRequest) -> DatabaseResult<Tested> {
    let started = Instant::now();
    let TestRequest { profile, password } = request;
    let id = profile.id.clone();
    let password =
        profiles::blocking(move || profiles::password_for(&data_dir, id.as_deref(), password))
            .await?;
    let session = Session::open(&profile.target, password.as_deref(), profile.read_only).await?;
    let version = session.version().await?;
    Ok(Tested {
        version,
        millis: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
    })
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Connected {
    pub id: String,
    pub version: String,
}

#[derive(Clone)]
struct Open {
    session: Session,
    version: String,
}

#[derive(Default)]
pub struct Pool {
    open: tokio::sync::Mutex<HashMap<String, Open>>,
}

impl Pool {
    async fn kept(&self, id: &str) -> Option<Open> {
        let mut open = self.open.lock().await;
        match open.get(id) {
            Some(kept) if kept.session.is_alive() => Some(kept.clone()),
            Some(_) => {
                open.remove(id);
                None
            }
            None => None,
        }
    }

    /// The open connection to a saved database, signing in first when there is none or it has dropped.
    async fn open(&self, data_dir: &Path, id: &str) -> DatabaseResult<Open> {
        if let Some(kept) = self.kept(id).await {
            return Ok(kept);
        }
        let dir = data_dir.to_path_buf();
        let wanted = id.to_string();
        let (profile, password) = profiles::blocking(move || {
            let profile = profiles::load(&dir).get(&wanted)?.clone();
            let password = profiles::password_for(&dir, Some(&wanted), None)?;
            Ok((profile, password))
        })
        .await?;
        let session =
            Session::open(&profile.target, password.as_deref(), profile.read_only).await?;
        let version = session.version().await?;
        let opened = Open { session, version };
        self.open
            .lock()
            .await
            .insert(id.to_string(), opened.clone());
        Ok(opened)
    }

    pub async fn connect(&self, data_dir: &Path, id: &str) -> DatabaseResult<Connected> {
        let opened = self.open(data_dir, id).await?;
        Ok(Connected {
            id: id.to_string(),
            version: opened.version,
        })
    }

    /// Closes the connection, as after its profile is edited or removed.
    pub async fn forget(&self, id: &str) {
        self.open.lock().await.remove(id);
    }

    pub async fn connected(&self) -> Vec<Connected> {
        let mut connected: Vec<Connected> = self
            .open
            .lock()
            .await
            .iter()
            .filter(|(_, kept)| kept.session.is_alive())
            .map(|(id, kept)| Connected {
                id: id.clone(),
                version: kept.version.clone(),
            })
            .collect();
        connected.sort_by(|a, b| a.id.cmp(&b.id));
        connected
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profiles::SaveRequest;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "sikemux-database-pool-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn save_sqlite(dir: &Path, name: &str, path: &Path) -> String {
        let request: SaveRequest = serde_json::from_value(serde_json::json!({
            "profile": { "name": name, "engine": "sqlite", "path": path }
        }))
        .unwrap();
        profiles::save(dir, request).unwrap().id
    }

    #[tokio::test]
    async fn a_connection_is_opened_once_and_forgotten_on_request() {
        let dir = scratch("once");
        let file = crate::engines::sqlite::tests::fixture("pool-once");
        let id = save_sqlite(&dir, "Local", &file);
        let pool = Pool::default();
        assert!(pool.connected().await.is_empty());
        let connected = pool.connect(&dir, &id).await.unwrap();
        assert!(connected.version.starts_with("SQLite"));
        assert_eq!(pool.connected().await, vec![connected]);
        pool.forget(&id).await;
        assert!(pool.connected().await.is_empty());
    }

    #[tokio::test]
    async fn an_unknown_profile_or_a_failed_sign_in_leaves_nothing_open() {
        let dir = scratch("failed");
        let pool = Pool::default();
        assert!(pool.connect(&dir, "nope").await.is_err());
        let id = save_sqlite(&dir, "Gone", Path::new("/nope/gone.db"));
        assert!(pool.connect(&dir, &id).await.is_err());
        assert!(pool.connected().await.is_empty());
    }
}

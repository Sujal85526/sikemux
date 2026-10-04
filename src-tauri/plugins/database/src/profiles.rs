// The databases saved here. Passwords live in the Keychain; the file beside
// them only says where each database is and how to reach it.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{DatabaseError, DatabaseResult};

#[cfg(not(test))]
const PASSWORD_SERVICE: &str = "sikemux-database-password";
/// Tests keep to an entry of their own, so they never replace or delete a real password.
#[cfg(test)]
const PASSWORD_SERVICE: &str = "sikemux-database-password-test";

pub const POSTGRES_PORT: u16 = 5432;

#[derive(Serialize, Deserialize, Clone, Copy, Default, PartialEq, Eq, Debug)]
#[serde(rename_all = "kebab-case")]
pub enum Tls {
    Disable,
    /// Encrypt when the server offers it, without checking its certificate.
    #[default]
    Prefer,
    /// Always encrypt, without checking the certificate.
    Require,
    /// Always encrypt, and check the certificate against the system's trusted roots.
    VerifyFull,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Eq, Debug)]
#[serde(tag = "engine", rename_all = "lowercase")]
pub enum Target {
    #[serde(rename_all = "camelCase")]
    Postgres {
        host: String,
        #[serde(default)]
        port: Option<u16>,
        database: String,
        user: String,
        #[serde(default)]
        tls: Tls,
    },
    Sqlite {
        path: String,
    },
}

impl Target {
    fn check(&self) -> DatabaseResult<()> {
        let missing = |what: &str| Err(DatabaseError::BadArg(format!("a {what} is needed")));
        match self {
            Self::Postgres { host, .. } if host.trim().is_empty() => missing("host"),
            Self::Postgres { user, .. } if user.trim().is_empty() => missing("user name"),
            Self::Sqlite { path } if path.trim().is_empty() => missing("database file"),
            _ => Ok(()),
        }
    }

    fn trimmed(self) -> Self {
        match self {
            Self::Postgres {
                host,
                port,
                database,
                user,
                tls,
            } => Self::Postgres {
                host: host.trim().to_string(),
                port,
                database: database.trim().to_string(),
                user: user.trim().to_string(),
                tls,
            },
            Self::Sqlite { path } => Self::Sqlite {
                path: path.trim().to_string(),
            },
        }
    }
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub name: String,
    /// Refuses statements that change data or schema, for agents and for people.
    #[serde(default)]
    pub read_only: bool,
    #[serde(default)]
    pub has_password: bool,
    #[serde(flatten)]
    pub target: Target,
}

#[derive(Serialize, Deserialize, Clone, Default, PartialEq, Eq, Debug)]
pub struct Profiles {
    #[serde(default)]
    pub profiles: Vec<Profile>,
}

impl Profiles {
    pub fn get(&self, id: &str) -> DatabaseResult<&Profile> {
        self.profiles
            .iter()
            .find(|profile| profile.id == id)
            .ok_or_else(|| DatabaseError::NotFound(format!("no saved database with id {id}")))
    }

    fn upsert(&mut self, profile: Profile) {
        match self.profiles.iter_mut().find(|kept| kept.id == profile.id) {
            Some(kept) => *kept = profile,
            None => self.profiles.push(profile),
        }
    }

    fn remove(&mut self, id: &str) -> Option<Profile> {
        let index = self.profiles.iter().position(|profile| profile.id == id)?;
        Some(self.profiles.remove(index))
    }
}

/// A profile as the form sends it: no id yet when it is new.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub read_only: bool,
    #[serde(flatten)]
    pub target: Target,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SaveRequest {
    pub profile: Draft,
    /// Left out to keep the saved password; empty to forget it.
    #[serde(default)]
    pub password: Option<String>,
}

#[derive(Deserialize, Debug)]
pub struct IdRequest {
    pub id: String,
}

fn profiles_path(data_dir: &Path) -> PathBuf {
    data_dir.join("profiles.json")
}

pub fn load(data_dir: &Path) -> Profiles {
    std::fs::read(profiles_path(data_dir))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn store(data_dir: &Path, profiles: &Profiles) -> DatabaseResult<()> {
    std::fs::create_dir_all(data_dir)?;
    let path = profiles_path(data_dir);
    let staged = path.with_extension("json.tmp");
    std::fs::write(&staged, serde_json::to_vec_pretty(profiles)?)?;
    std::fs::rename(&staged, &path)?;
    Ok(())
}

/// Saves the profile and its password, and returns it as saved.
pub fn save(data_dir: &Path, request: SaveRequest) -> DatabaseResult<Profile> {
    let SaveRequest { profile, password } = request;
    let name = profile.name.trim().to_string();
    if name.is_empty() {
        return Err(DatabaseError::BadArg("a name is needed".into()));
    }
    let target = profile.target.trimmed();
    target.check()?;
    let mut profiles = load(data_dir);
    let existing = profile
        .id
        .as_deref()
        .map(|id| profiles.get(id).cloned())
        .transpose()?;
    if profiles
        .profiles
        .iter()
        .any(|kept| kept.name.eq_ignore_ascii_case(&name) && Some(&kept.id) != profile.id.as_ref())
    {
        return Err(DatabaseError::BadArg(format!(
            "a database named {name} is already saved"
        )));
    }
    let id = existing
        .as_ref()
        .map_or_else(|| uuid::Uuid::new_v4().to_string(), |kept| kept.id.clone());
    let has_password = match password.as_deref().map(str::trim) {
        Some("") => {
            password_delete(&id)?;
            false
        }
        Some(password) => {
            password_write(&id, password)?;
            true
        }
        None => existing.as_ref().is_some_and(|kept| kept.has_password),
    };
    let saved = Profile {
        id,
        name,
        read_only: profile.read_only,
        has_password,
        target,
    };
    profiles.upsert(saved.clone());
    store(data_dir, &profiles)?;
    Ok(saved)
}

pub fn remove(data_dir: &Path, id: &str) -> DatabaseResult<()> {
    let mut profiles = load(data_dir);
    if let Some(removed) = profiles.remove(id) {
        store(data_dir, &profiles)?;
        if removed.has_password {
            password_delete(&removed.id)?;
        }
    }
    Ok(())
}

fn keychain_error(error: sikemux_keychain::KeychainError) -> DatabaseError {
    match error {
        sikemux_keychain::KeychainError::Invalid(message) => DatabaseError::BadArg(message),
        sikemux_keychain::KeychainError::Failed(message) => DatabaseError::Keychain(message),
    }
}

/// The Keychain helper takes only token-like text, and passwords can hold any character.
fn to_hex(text: &str) -> String {
    text.bytes().map(|byte| format!("{byte:02x}")).collect()
}

fn from_hex(hex: &str) -> Option<String> {
    let digits: Vec<u8> = hex
        .chars()
        .map(|c| c.to_digit(16).and_then(|digit| u8::try_from(digit).ok()))
        .collect::<Option<_>>()?;
    let bytes = digits
        .chunks(2)
        .map(|pair| match pair {
            [high, low] => Some(high * 16 + low),
            _ => None,
        })
        .collect::<Option<Vec<u8>>>()?;
    String::from_utf8(bytes).ok()
}

pub fn password_read(id: &str) -> DatabaseResult<Option<String>> {
    let stored = sikemux_keychain::read(PASSWORD_SERVICE, id).map_err(keychain_error)?;
    Ok(stored.as_deref().and_then(from_hex))
}

/// The password to sign in with: the one just typed, or else the saved one.
pub fn password_for(
    data_dir: &Path,
    id: Option<&str>,
    typed: Option<String>,
) -> DatabaseResult<Option<String>> {
    if typed.is_some() {
        return Ok(typed);
    }
    let Some(id) = id else { return Ok(None) };
    let profiles = load(data_dir);
    match profiles.get(id) {
        Ok(profile) if profile.has_password => password_read(id),
        _ => Ok(None),
    }
}

fn password_write(id: &str, password: &str) -> DatabaseResult<()> {
    sikemux_keychain::write(PASSWORD_SERVICE, id, &to_hex(password)).map_err(keychain_error)
}

fn password_delete(id: &str) -> DatabaseResult<()> {
    sikemux_keychain::delete(PASSWORD_SERVICE, id).map_err(keychain_error)
}

/// Runs Keychain and disk work on a thread meant for blocking, away from the few threads every plugin shares.
pub async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> DatabaseResult<T> + Send + 'static,
) -> DatabaseResult<T> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| DatabaseError::Storage(error.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("sikemux-database-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn sqlite(name: &str, path: &str) -> SaveRequest {
        SaveRequest {
            profile: Draft {
                id: None,
                name: name.into(),
                read_only: false,
                target: Target::Sqlite { path: path.into() },
            },
            password: None,
        }
    }

    #[test]
    fn a_password_survives_the_round_trip_through_hex() {
        for password in ["", "plain", "p@ss w0rd!#$%^&*()\"'", "pässwörd 🔑"] {
            assert_eq!(from_hex(&to_hex(password)).as_deref(), Some(password));
        }
        assert_eq!(from_hex("abc"), None);
        assert_eq!(from_hex("zz"), None);
    }

    #[test]
    fn a_typed_password_wins_and_no_saved_one_means_none() {
        let dir = scratch("password-for");
        let saved = save(&dir, sqlite("Local", "/tmp/a.db")).unwrap();
        assert_eq!(
            password_for(&dir, Some(&saved.id), Some("typed".into())).unwrap(),
            Some("typed".into())
        );
        assert_eq!(password_for(&dir, Some(&saved.id), None).unwrap(), None);
        assert_eq!(password_for(&dir, None, None).unwrap(), None);
    }

    #[test]
    fn profiles_read_and_write_with_the_engine_beside_the_fields() {
        let json = r#"{"id":"1","name":"Shop","engine":"postgres","host":"localhost","database":"shop","user":"app","tls":"verify-full"}"#;
        let profile: Profile = serde_json::from_str(json).unwrap();
        assert_eq!(
            profile.target,
            Target::Postgres {
                host: "localhost".into(),
                port: None,
                database: "shop".into(),
                user: "app".into(),
                tls: Tls::VerifyFull,
            }
        );
        let written = serde_json::to_value(&profile).unwrap();
        assert_eq!(written["engine"], "postgres");
        assert_eq!(written["readOnly"], false);
    }

    #[test]
    fn saving_gives_a_new_profile_an_id_and_keeps_it_on_edit() {
        let dir = scratch("save");
        let saved = save(&dir, sqlite(" Local ", " /tmp/a.db ")).unwrap();
        assert_eq!(saved.name, "Local");
        assert_eq!(
            saved.target,
            Target::Sqlite {
                path: "/tmp/a.db".into()
            }
        );
        let mut edit = sqlite("Local copy", "/tmp/b.db");
        edit.profile.id = Some(saved.id.clone());
        let edited = save(&dir, edit).unwrap();
        assert_eq!(edited.id, saved.id);
        assert_eq!(load(&dir).profiles, vec![edited]);
        remove(&dir, &saved.id).unwrap();
        assert!(load(&dir).profiles.is_empty());
    }

    #[test]
    fn names_are_unique_and_required_fields_are_checked() {
        let dir = scratch("checks");
        save(&dir, sqlite("Local", "/tmp/a.db")).unwrap();
        assert!(matches!(
            save(&dir, sqlite("local", "/tmp/b.db")),
            Err(DatabaseError::BadArg(_))
        ));
        assert!(matches!(
            save(&dir, sqlite("  ", "/tmp/b.db")),
            Err(DatabaseError::BadArg(_))
        ));
        assert!(matches!(
            save(&dir, sqlite("Other", " ")),
            Err(DatabaseError::BadArg(_))
        ));
        let mut unknown = sqlite("Ghost", "/tmp/c.db");
        unknown.profile.id = Some("nope".into());
        assert!(matches!(
            save(&dir, unknown),
            Err(DatabaseError::NotFound(_))
        ));
    }
}

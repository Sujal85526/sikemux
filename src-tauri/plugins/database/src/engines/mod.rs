// One open connection to a saved database, whichever engine it runs on.

pub mod sqlite;

use crate::error::DatabaseResult;
use crate::profiles::Target;

#[derive(Clone)]
pub enum Session {
    Sqlite(sqlite::Session),
}

impl Session {
    pub async fn open(target: &Target, read_only: bool) -> DatabaseResult<Self> {
        match target {
            Target::Sqlite { path } => {
                Ok(Self::Sqlite(sqlite::Session::open(path, read_only).await?))
            }
            Target::Postgres { .. } => Err(crate::error::DatabaseError::Connect(
                "PostgreSQL is not supported yet".into(),
            )),
        }
    }

    /// The engine and its version, such as `SQLite 3.46.0`.
    pub async fn version(&self) -> DatabaseResult<String> {
        match self {
            Self::Sqlite(session) => session.version().await,
        }
    }
}

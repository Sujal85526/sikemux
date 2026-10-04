// One open connection to a saved database, whichever engine it runs on.

pub mod postgres;
pub mod sqlite;
mod tls;

use crate::error::DatabaseResult;
use crate::profiles::Target;

#[derive(Clone)]
pub enum Session {
    Postgres(postgres::Session),
    Sqlite(sqlite::Session),
}

impl Session {
    pub async fn open(
        target: &Target,
        password: Option<&str>,
        read_only: bool,
    ) -> DatabaseResult<Self> {
        match target {
            Target::Postgres {
                host,
                port,
                database,
                user,
                tls,
            } => {
                let address = postgres::Address {
                    host,
                    port: *port,
                    database,
                    user,
                    tls: *tls,
                };
                Ok(Self::Postgres(
                    postgres::Session::open(address, password, read_only).await?,
                ))
            }
            Target::Sqlite { path } => {
                Ok(Self::Sqlite(sqlite::Session::open(path, read_only).await?))
            }
        }
    }

    /// The engine and its version, such as `PostgreSQL 16.4` or `SQLite 3.46.0`.
    pub async fn version(&self) -> DatabaseResult<String> {
        match self {
            Self::Postgres(session) => session.version().await,
            Self::Sqlite(session) => session.version().await,
        }
    }
}

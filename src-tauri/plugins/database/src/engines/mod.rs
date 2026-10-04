// One open connection to a saved database, whichever engine it runs on.

pub mod postgres;
pub mod sqlite;
mod tls;

use crate::error::DatabaseResult;
use crate::profiles::Target;
use crate::schema::{Table, TableInfo};
use crate::values::ResultSet;

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
            Target::Postgres(server) => Ok(Self::Postgres(
                postgres::Session::open(server, password, read_only).await?,
            )),
            Target::Sqlite { path } => {
                Ok(Self::Sqlite(sqlite::Session::open(path, read_only).await?))
            }
        }
    }

    /// Whether the connection is still up. A PostgreSQL server can drop it; a SQLite file stays open.
    pub fn is_alive(&self) -> bool {
        match self {
            Self::Postgres(session) => session.is_alive(),
            Self::Sqlite(_) => true,
        }
    }

    /// The engine and its version, such as `PostgreSQL 16.4` or `SQLite 3.46.0`.
    pub async fn version(&self) -> DatabaseResult<String> {
        match self {
            Self::Postgres(session) => session.version().await,
            Self::Sqlite(session) => session.version().await,
        }
    }

    /// The schema a table is looked for in when none is named.
    pub fn default_schema(&self) -> &'static str {
        match self {
            Self::Postgres(_) => "public",
            Self::Sqlite(_) => "main",
        }
    }

    pub async fn schemas(&self) -> DatabaseResult<Vec<String>> {
        match self {
            Self::Postgres(session) => session.schemas().await,
            Self::Sqlite(session) => session.schemas().await,
        }
    }

    pub async fn tables(&self, schema: Option<String>) -> DatabaseResult<Vec<Table>> {
        let schema = schema.unwrap_or_else(|| self.default_schema().to_string());
        match self {
            Self::Postgres(session) => session.tables(&schema).await,
            Self::Sqlite(session) => session.tables(schema).await,
        }
    }

    pub async fn describe(
        &self,
        schema: Option<String>,
        table: String,
    ) -> DatabaseResult<TableInfo> {
        let schema = schema.unwrap_or_else(|| self.default_schema().to_string());
        match self {
            Self::Postgres(session) => session.describe(&schema, &table).await,
            Self::Sqlite(session) => session.describe(schema, table).await,
        }
    }

    pub async fn query(&self, sql: &str, limit: usize) -> DatabaseResult<Vec<ResultSet>> {
        match self {
            Self::Postgres(session) => session.query(sql, limit).await,
            Self::Sqlite(session) => session.query(sql.to_string(), limit).await,
        }
    }

    /// Stops the statement running on this connection, if any.
    pub async fn cancel(&self) -> DatabaseResult<()> {
        match self {
            Self::Postgres(session) => session.cancel().await,
            Self::Sqlite(session) => {
                session.cancel();
                Ok(())
            }
        }
    }
}

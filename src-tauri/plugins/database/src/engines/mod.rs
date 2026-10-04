// One open connection to a saved database, whichever engine it runs on.

pub mod mysql;
pub mod postgres;
pub mod sqlite;
mod tls;

use crate::error::DatabaseResult;
use crate::profiles::Target;
use crate::schema::{Table, TableInfo};
use crate::values::ResultSet;

#[derive(Clone)]
pub enum Session {
    Mysql(mysql::Session),
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
            Target::Mysql(server) => Ok(Self::Mysql(
                mysql::Session::open(server, password, read_only).await?,
            )),
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
            Self::Mysql(session) => session.is_alive(),
            Self::Postgres(session) => session.is_alive(),
            Self::Sqlite(_) => true,
        }
    }

    /// The engine and its version, such as `PostgreSQL 16.4` or `SQLite 3.46.0`.
    pub async fn version(&self) -> DatabaseResult<String> {
        match self {
            Self::Mysql(session) => session.version().await,
            Self::Postgres(session) => session.version().await,
            Self::Sqlite(session) => session.version().await,
        }
    }

    /// The schema a table is looked for in when none is named.
    pub fn default_schema(&self) -> String {
        match self {
            Self::Mysql(session) => session.default_schema(),
            Self::Postgres(_) => "public".into(),
            Self::Sqlite(_) => "main".into(),
        }
    }

    /// The schema asked for, or the default one. A MySQL connection that names no database has none.
    fn schema_or_default(&self, schema: Option<String>) -> DatabaseResult<String> {
        match schema.filter(|schema| !schema.is_empty()) {
            Some(schema) => Ok(schema),
            None => Some(self.default_schema())
                .filter(|schema| !schema.is_empty())
                .ok_or_else(|| {
                    crate::error::DatabaseError::BadArg(
                        "this connection names no database, so name a schema".into(),
                    )
                }),
        }
    }

    pub async fn schemas(&self) -> DatabaseResult<Vec<String>> {
        match self {
            Self::Mysql(session) => session.schemas().await,
            Self::Postgres(session) => session.schemas().await,
            Self::Sqlite(session) => session.schemas().await,
        }
    }

    pub async fn tables(&self, schema: Option<String>) -> DatabaseResult<Vec<Table>> {
        let schema = self.schema_or_default(schema)?;
        match self {
            Self::Mysql(session) => session.tables(&schema).await,
            Self::Postgres(session) => session.tables(&schema).await,
            Self::Sqlite(session) => session.tables(schema).await,
        }
    }

    pub async fn describe(
        &self,
        schema: Option<String>,
        table: String,
    ) -> DatabaseResult<TableInfo> {
        let schema = self.schema_or_default(schema)?;
        match self {
            Self::Mysql(session) => session.describe(&schema, &table).await,
            Self::Postgres(session) => session.describe(&schema, &table).await,
            Self::Sqlite(session) => session.describe(schema, table).await,
        }
    }

    pub async fn query(&self, sql: &str, limit: usize) -> DatabaseResult<Vec<ResultSet>> {
        match self {
            Self::Mysql(session) => session.query(sql, limit).await,
            Self::Postgres(session) => session.query(sql, limit).await,
            Self::Sqlite(session) => session.query(sql.to_string(), limit).await,
        }
    }

    /// Stops the statement running on this connection, if any.
    pub async fn cancel(&self) -> DatabaseResult<()> {
        match self {
            Self::Mysql(session) => session.cancel().await,
            Self::Postgres(session) => session.cancel().await,
            Self::Sqlite(session) => {
                session.cancel();
                Ok(())
            }
        }
    }
}

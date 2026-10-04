// SQLite: a file on this Mac, opened in place. Every call runs on a thread
// meant for blocking, since SQLite does its work on the calling thread.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use rusqlite::{Connection, OpenFlags};

use crate::error::{DatabaseError, DatabaseResult};

#[derive(Clone)]
pub struct Session {
    connection: Arc<Mutex<Connection>>,
}

/// `~/data/app.db` is the person's own home folder, as it would be in a terminal.
fn expand(path: &str) -> PathBuf {
    match (path.strip_prefix("~/"), std::env::var_os("HOME")) {
        (Some(rest), Some(home)) => PathBuf::from(home).join(rest),
        _ => PathBuf::from(path),
    }
}

impl Session {
    /// Opens the file without ever creating it, so a mistyped path is an error rather than an empty database.
    pub async fn open(path: &str, read_only: bool) -> DatabaseResult<Self> {
        let file = expand(path);
        tokio::task::spawn_blocking(move || {
            if !file.is_file() {
                return Err(DatabaseError::Connect(format!(
                    "there is no database file at {}",
                    file.display()
                )));
            }
            let access = if read_only {
                OpenFlags::SQLITE_OPEN_READ_ONLY
            } else {
                OpenFlags::SQLITE_OPEN_READ_WRITE
            };
            let connection =
                Connection::open_with_flags(&file, access | OpenFlags::SQLITE_OPEN_NO_MUTEX)
                    .map_err(|error| DatabaseError::Connect(format!("sqlite: {error}")))?;
            connection
                .busy_timeout(std::time::Duration::from_secs(5))
                .map_err(|error| DatabaseError::Connect(format!("sqlite: {error}")))?;
            Ok(Self {
                connection: Arc::new(Mutex::new(connection)),
            })
        })
        .await
        .map_err(|error| DatabaseError::Connect(error.to_string()))?
    }

    /// Runs work against the connection on a thread meant for blocking.
    pub async fn with<T: Send + 'static>(
        &self,
        work: impl FnOnce(&Connection) -> rusqlite::Result<T> + Send + 'static,
    ) -> DatabaseResult<T> {
        let connection = Arc::clone(&self.connection);
        tokio::task::spawn_blocking(move || {
            let connection = connection
                .lock()
                .map_err(|_| DatabaseError::Query("sqlite: an earlier query crashed".into()))?;
            work(&connection).map_err(|error| DatabaseError::Query(format!("sqlite: {error}")))
        })
        .await
        .map_err(|error| DatabaseError::Query(error.to_string()))?
    }

    pub async fn version(&self) -> DatabaseResult<String> {
        let version = self
            .with(|connection| {
                connection.query_row("select sqlite_version()", [], |row| row.get::<_, String>(0))
            })
            .await?;
        Ok(format!("SQLite {version}"))
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;

    /// A fresh database file with a small table in it.
    pub fn fixture(name: &str) -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("sikemux-database-{name}-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(
                "create table customers (id integer primary key, name text not null, email text unique);
                 insert into customers (name, email) values ('Ada', 'ada@example.com'), ('Linus', null);",
            )
            .unwrap();
        path
    }

    #[tokio::test]
    async fn it_opens_a_file_and_reads_its_version() {
        let path = fixture("open");
        let session = Session::open(path.to_str().unwrap(), false).await.unwrap();
        assert!(session.version().await.unwrap().starts_with("SQLite 3."));
        let count = session
            .with(|connection| {
                connection.query_row("select count(*) from customers", [], |row| {
                    row.get::<_, i64>(0)
                })
            })
            .await
            .unwrap();
        assert_eq!(count, 2);
    }

    #[tokio::test]
    async fn a_missing_file_is_never_created() {
        let path = std::env::temp_dir().join(format!(
            "sikemux-database-missing-{}.db",
            std::process::id()
        ));
        let opened = Session::open(path.to_str().unwrap(), false).await;
        assert!(matches!(opened, Err(DatabaseError::Connect(_))));
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn read_only_refuses_writes() {
        let path = fixture("read-only");
        let session = Session::open(path.to_str().unwrap(), true).await.unwrap();
        let write = session
            .with(|connection| connection.execute("delete from customers", []))
            .await;
        assert!(matches!(write, Err(DatabaseError::Query(_))));
    }

    #[test]
    fn a_tilde_is_the_home_folder() {
        let home = std::env::var("HOME").unwrap();
        assert_eq!(expand("~/a.db"), PathBuf::from(home).join("a.db"));
        assert_eq!(expand("/tmp/a.db"), PathBuf::from("/tmp/a.db"));
    }
}

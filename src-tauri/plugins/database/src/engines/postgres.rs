// PostgreSQL over the network, with the client kept open between calls.

use std::sync::Arc;
use std::time::Duration;

use tokio_postgres::config::SslMode;
use tokio_postgres::{Client, Config};

use super::tls;
use crate::error::{DatabaseError, DatabaseResult};
use crate::profiles::{Tls, POSTGRES_PORT};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

pub struct Address<'a> {
    pub host: &'a str,
    pub port: Option<u16>,
    pub database: &'a str,
    pub user: &'a str,
    pub tls: Tls,
}

#[derive(Clone)]
pub struct Session {
    client: Arc<Client>,
}

/// PostgreSQL's own words for a failure, with its detail and hint, rather than the bare "db error".
pub fn describe(error: &tokio_postgres::Error) -> String {
    if let Some(db) = error.as_db_error() {
        let mut text = db.message().to_string();
        if let Some(detail) = db.detail() {
            text.push_str(&format!("\n{detail}"));
        }
        if let Some(hint) = db.hint() {
            text.push_str(&format!("\nHint: {hint}"));
        }
        return text;
    }
    let mut text = error.to_string();
    let mut source = std::error::Error::source(error);
    while let Some(cause) = source {
        text.push_str(&format!(": {cause}"));
        source = cause.source();
    }
    text
}

fn ssl_mode(tls: Tls) -> SslMode {
    match tls {
        Tls::Disable => SslMode::Disable,
        Tls::Prefer => SslMode::Prefer,
        Tls::Require | Tls::VerifyFull => SslMode::Require,
    }
}

impl Session {
    pub async fn open(
        address: Address<'_>,
        password: Option<&str>,
        read_only: bool,
    ) -> DatabaseResult<Self> {
        let mut config = Config::new();
        config
            .host(address.host)
            .port(address.port.unwrap_or(POSTGRES_PORT))
            .user(address.user)
            .application_name("Sikemux")
            .connect_timeout(CONNECT_TIMEOUT)
            .ssl_mode(ssl_mode(address.tls));
        if !address.database.is_empty() {
            config.dbname(address.database);
        }
        if let Some(password) = password.filter(|password| !password.is_empty()) {
            config.password(password);
        }
        let connector = tls::connector(address.tls == Tls::VerifyFull)?;
        let connecting = tokio::time::timeout(CONNECT_TIMEOUT, config.connect(connector));
        let (client, connection) = connecting
            .await
            .map_err(|_| {
                DatabaseError::Connect(format!(
                    "{}:{} did not answer within {}s",
                    address.host,
                    address.port.unwrap_or(POSTGRES_PORT),
                    CONNECT_TIMEOUT.as_secs()
                ))
            })?
            .map_err(|error| DatabaseError::Connect(describe(&error)))?;
        tokio::spawn(connection);
        if read_only {
            client
                .batch_execute("set default_transaction_read_only = on")
                .await
                .map_err(|error| DatabaseError::Connect(describe(&error)))?;
        }
        Ok(Self {
            client: Arc::new(client),
        })
    }

    pub fn is_alive(&self) -> bool {
        !self.client.is_closed()
    }

    pub async fn version(&self) -> DatabaseResult<String> {
        let row = self
            .client
            .query_one("show server_version", &[])
            .await
            .map_err(|error| DatabaseError::Query(describe(&error)))?;
        let version: String = row.get(0);
        Ok(format!("PostgreSQL {version}"))
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;

    /// A server to test against, from `SIKEMUX_TEST_POSTGRES` as `host:port/database/user`.
    /// Without it the tests that need a live server pass without running.
    pub fn server() -> Option<(String, u16, String, String)> {
        let given = std::env::var("SIKEMUX_TEST_POSTGRES").ok()?;
        let (host_port, rest) = given.split_once('/')?;
        let (database, user) = rest.split_once('/')?;
        let (host, port) = host_port.split_once(':').unwrap_or((host_port, "5432"));
        Some((
            host.into(),
            port.parse().ok()?,
            database.into(),
            user.into(),
        ))
    }

    pub async fn open_test_server(read_only: bool) -> Option<Session> {
        let (host, port, database, user) = server()?;
        let address = Address {
            host: &host,
            port: Some(port),
            database: &database,
            user: &user,
            tls: Tls::Prefer,
        };
        Some(Session::open(address, None, read_only).await.unwrap())
    }

    #[test]
    fn modes_map_to_postgres_ssl_modes() {
        assert!(matches!(ssl_mode(Tls::Disable), SslMode::Disable));
        assert!(matches!(ssl_mode(Tls::Prefer), SslMode::Prefer));
        assert!(matches!(ssl_mode(Tls::Require), SslMode::Require));
        assert!(matches!(ssl_mode(Tls::VerifyFull), SslMode::Require));
    }

    #[tokio::test]
    async fn nobody_listening_is_a_connect_error_naming_the_cause() {
        let address = Address {
            host: "127.0.0.1",
            port: Some(1),
            database: "",
            user: "nobody",
            tls: Tls::Disable,
        };
        let failed = Session::open(address, None, false).await;
        let Err(DatabaseError::Connect(message)) = failed else {
            panic!("expected a connect error");
        };
        assert!(message.to_lowercase().contains("refused"), "{message}");
    }

    #[tokio::test]
    async fn a_live_server_reports_its_version_and_keeps_read_only() {
        let Some(session) = open_test_server(true).await else {
            return;
        };
        assert!(session.version().await.unwrap().starts_with("PostgreSQL "));
        let write = session
            .client
            .batch_execute("create temporary table sikemux_probe (id int)")
            .await;
        let error = write
            .err()
            .map(|error| describe(&error))
            .unwrap_or_default();
        assert!(error.contains("read-only"), "{error}");
    }
}

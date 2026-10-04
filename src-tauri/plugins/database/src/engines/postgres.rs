// PostgreSQL over the network, with the client kept open between calls.

use std::sync::Arc;
use std::time::Duration;

use tokio_postgres::config::SslMode;
use tokio_postgres::{Client, Config};

use super::tls;
use crate::error::{DatabaseError, DatabaseResult};
use crate::profiles::{Tls, POSTGRES_PORT};
use crate::schema::{ColumnInfo, ForeignKey, Index, Table, TableInfo, TableKind};

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

fn query_error(error: tokio_postgres::Error) -> DatabaseError {
    DatabaseError::Query(describe(&error))
}

const SCHEMAS: &str = "select nspname::text from pg_namespace \
     where nspname not in ('pg_catalog', 'information_schema', 'pg_toast') \
       and nspname not like 'pg_temp_%' and nspname not like 'pg_toast_temp_%' \
       and has_schema_privilege(oid, 'USAGE') \
     order by nspname = 'public' desc, nspname";

const TABLES: &str = "select c.relname::text, c.relkind::text from pg_class c \
     join pg_namespace n on n.oid = c.relnamespace \
     where n.nspname = $1 and c.relkind in ('r', 'p', 'v', 'm', 'f') \
     order by c.relname";

const KIND: &str = "select c.relkind::text from pg_class c \
     join pg_namespace n on n.oid = c.relnamespace \
     where n.nspname = $1 and c.relname = $2 and c.relkind in ('r', 'p', 'v', 'm', 'f')";

const COLUMNS: &str =
    "select a.attname::text, format_type(a.atttypid, a.atttypmod), not a.attnotnull, \
            pg_get_expr(d.adbin, d.adrelid), coalesce(a.attnum = any(i.indkey), false) \
     from pg_attribute a \
     join pg_class c on c.oid = a.attrelid \
     join pg_namespace n on n.oid = c.relnamespace \
     left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum \
     left join pg_index i on i.indrelid = c.oid and i.indisprimary \
     where n.nspname = $1 and c.relname = $2 and a.attnum > 0 and not a.attisdropped \
     order by a.attnum";

const INDEXES: &str = "select ic.relname::text, i.indisunique, i.indisprimary, \
            array(select coalesce(a.attname::text, pg_get_indexdef(i.indexrelid, k.ord::int, true)) \
                  from unnest(i.indkey) with ordinality k(attnum, ord) \
                  left join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum \
                  order by k.ord) \
     from pg_index i \
     join pg_class ic on ic.oid = i.indexrelid \
     join pg_class c on c.oid = i.indrelid \
     join pg_namespace n on n.oid = c.relnamespace \
     where n.nspname = $1 and c.relname = $2 \
     order by i.indisprimary desc, ic.relname";

const FOREIGN_KEYS: &str = "select con.conname::text, \
            array(select a.attname::text from unnest(con.conkey) with ordinality k(num, ord) \
                  join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.num order by k.ord), \
            fn.nspname::text, fc.relname::text, \
            array(select a.attname::text from unnest(con.confkey) with ordinality k(num, ord) \
                  join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.num order by k.ord) \
     from pg_constraint con \
     join pg_class c on c.oid = con.conrelid \
     join pg_namespace n on n.oid = c.relnamespace \
     join pg_class fc on fc.oid = con.confrelid \
     join pg_namespace fn on fn.oid = fc.relnamespace \
     where con.contype = 'f' and n.nspname = $1 and c.relname = $2 \
     order by con.conname";

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

    /// The schemas this user may look into, `public` first.
    pub async fn schemas(&self) -> DatabaseResult<Vec<String>> {
        let rows = self.client.query(SCHEMAS, &[]).await.map_err(query_error)?;
        Ok(rows.iter().map(|row| row.get(0)).collect())
    }

    pub async fn tables(&self, schema: &str) -> DatabaseResult<Vec<Table>> {
        let rows = self
            .client
            .query(TABLES, &[&schema])
            .await
            .map_err(query_error)?;
        Ok(rows
            .iter()
            .map(|row| Table {
                name: row.get(0),
                kind: TableKind::from_postgres(row.get(1)),
            })
            .collect())
    }

    pub async fn describe(&self, schema: &str, table: &str) -> DatabaseResult<TableInfo> {
        let params: [&(dyn tokio_postgres::types::ToSql + Sync); 2] = [&schema, &table];
        let kind = self
            .client
            .query_opt(KIND, &params)
            .await
            .map_err(query_error)?
            .ok_or_else(|| {
                DatabaseError::NotFound(format!("there is no table or view named {schema}.{table}"))
            })?;
        let columns = self
            .client
            .query(COLUMNS, &params)
            .await
            .map_err(query_error)?;
        let indexes = self
            .client
            .query(INDEXES, &params)
            .await
            .map_err(query_error)?;
        let foreign_keys = self
            .client
            .query(FOREIGN_KEYS, &params)
            .await
            .map_err(query_error)?;
        Ok(TableInfo {
            schema: schema.to_string(),
            name: table.to_string(),
            kind: TableKind::from_postgres(kind.get(0)),
            columns: columns
                .iter()
                .map(|row| ColumnInfo {
                    name: row.get(0),
                    type_name: row.get(1),
                    nullable: row.get(2),
                    default: row.get(3),
                    primary_key: row.get(4),
                })
                .collect(),
            indexes: indexes
                .iter()
                .map(|row| Index {
                    name: row.get(0),
                    unique: row.get(1),
                    primary: row.get(2),
                    columns: row.get(3),
                })
                .collect(),
            foreign_keys: foreign_keys
                .iter()
                .map(|row| ForeignKey {
                    name: row.get(0),
                    columns: row.get(1),
                    references_schema: row.get(2),
                    references_table: row.get(3),
                    references_columns: row.get(4),
                })
                .collect(),
        })
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

    /// A schema of its own for one test, with two related tables and a view, dropped when the test is done.
    pub struct Scratch {
        pub session: Session,
        pub schema: String,
    }

    impl Scratch {
        pub async fn new(name: &str) -> Option<Self> {
            let session = open_test_server(false).await?;
            let schema = format!("sikemux_{name}_{}", std::process::id());
            session
                .client
                .batch_execute(&format!(
                    "drop schema if exists {schema} cascade;
                     create schema {schema};
                     create table {schema}.customers (id serial primary key, name text not null, email text unique);
                     create table {schema}.orders (
                         id bigserial primary key,
                         customer_id int not null references {schema}.customers(id),
                         total numeric(10, 2) default 0,
                         placed_at timestamptz,
                         paid boolean,
                         note bytea,
                         tags text[]
                     );
                     create index orders_by_customer on {schema}.orders (customer_id, lower(coalesce(tags[1], '')));
                     create view {schema}.big_orders as select * from {schema}.orders where total > 10;
                     insert into {schema}.customers (name, email) values ('Ada', 'ada@example.com'), ('Linus', null);
                     insert into {schema}.orders (customer_id, total, placed_at, paid, note, tags)
                         values (1, 42.50, '2026-10-04 09:30:00+00', true, '\\xcafe', array['rush']),
                                (1, 9.99, null, false, null, null);"
                ))
                .await
                .unwrap();
            Some(Self { session, schema })
        }

        pub async fn drop(self) {
            let _ = self
                .session
                .client
                .batch_execute(&format!("drop schema if exists {} cascade", self.schema))
                .await;
        }
    }

    #[tokio::test]
    async fn a_live_server_lists_schemas_and_tables() {
        let Some(scratch) = Scratch::new("tables").await else {
            return;
        };
        let schemas = scratch.session.schemas().await.unwrap();
        assert_eq!(schemas.first().map(String::as_str), Some("public"));
        assert!(schemas.contains(&scratch.schema));
        let tables = scratch.session.tables(&scratch.schema).await.unwrap();
        let named: Vec<(&str, TableKind)> = tables
            .iter()
            .map(|table| (table.name.as_str(), table.kind))
            .collect();
        assert_eq!(
            named,
            vec![
                ("big_orders", TableKind::View),
                ("customers", TableKind::Table),
                ("orders", TableKind::Table)
            ]
        );
        scratch.drop().await;
    }

    #[tokio::test]
    async fn a_live_server_describes_a_table_with_its_keys_and_indexes() {
        let Some(scratch) = Scratch::new("describe").await else {
            return;
        };
        let orders = scratch
            .session
            .describe(&scratch.schema, "orders")
            .await
            .unwrap();
        let columns: Vec<(&str, &str, bool, bool)> = orders
            .columns
            .iter()
            .map(|column| {
                (
                    column.name.as_str(),
                    column.type_name.as_str(),
                    column.nullable,
                    column.primary_key,
                )
            })
            .collect();
        assert_eq!(columns[0], ("id", "bigint", false, true));
        assert_eq!(columns[1], ("customer_id", "integer", false, false));
        assert_eq!(columns[2], ("total", "numeric(10,2)", true, false));
        assert_eq!(columns[6], ("tags", "text[]", true, false));
        assert!(orders.columns[0]
            .default
            .as_deref()
            .unwrap_or_default()
            .starts_with("nextval("));
        assert_eq!(orders.indexes[0].name, "orders_pkey");
        assert!(orders.indexes[0].primary);
        let by_customer = orders
            .indexes
            .iter()
            .find(|index| index.name == "orders_by_customer")
            .unwrap();
        assert_eq!(by_customer.columns[0], "customer_id");
        assert!(
            by_customer.columns[1].contains("lower"),
            "{:?}",
            by_customer.columns
        );
        assert_eq!(orders.foreign_keys.len(), 1);
        assert_eq!(
            orders.foreign_keys[0].columns,
            vec!["customer_id".to_string()]
        );
        assert_eq!(orders.foreign_keys[0].references_table, "customers");
        assert_eq!(
            orders.foreign_keys[0].references_schema.as_deref(),
            Some(scratch.schema.as_str())
        );
        let view = scratch
            .session
            .describe(&scratch.schema, "big_orders")
            .await
            .unwrap();
        assert_eq!(view.kind, TableKind::View);
        assert!(matches!(
            scratch.session.describe(&scratch.schema, "nope").await,
            Err(DatabaseError::NotFound(_))
        ));
        scratch.drop().await;
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

//! What the phone app calls to pair with a Mac and talk to its core. The
//! connection, pairing and wire format are the core's own (`sikemux-core`),
//! so the phone and the Mac cannot drift apart; this crate only exposes them
//! through UniFFI.
//!
//! Requests and answers cross as the core's protocol JSON, the same shapes
//! `sikemux_core::protocol::{Request, Response, Event}` serialize to.
//! Terminal bytes cross as bytes.

use std::sync::{Arc, LazyLock, Mutex};

use iroh::endpoint::presets;
use iroh::{Endpoint, EndpointAddr, SecretKey};
use sikemux_core::client::{ClientError, CoreClient, EventSink, Reply};
use sikemux_core::pairing::{self, PairError, PairingRequest};
use sikemux_core::protocol::{CallId, Event, Request, SessionId, WindowCall, PROTOCOL_VERSION};
use sikemux_core::remote;

#[cfg(target_os = "android")]
mod android;

uniffi::setup_scaffolding!();

/// iroh and the core's client both need a Tokio runtime, which the phone's
/// JavaScript thread does not have.
static RUNTIME: LazyLock<tokio::runtime::Runtime> = LazyLock::new(|| {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .thread_name("sikemux-mobile")
        .build()
        .expect("the phone could not start its network runtime")
});

async fn on_runtime<T: Send + 'static>(
    work: impl std::future::Future<Output = T> + Send + 'static,
) -> T {
    RUNTIME
        .spawn(work)
        .await
        .expect("network work on the phone stopped unexpectedly")
}

#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum MobileError {
    #[error("{message}")]
    Refused { message: String },
    #[error("the code does not match the one on the Mac")]
    WrongCode,
    #[error("{message}")]
    Connection { message: String },
    #[error("{message}")]
    Invalid { message: String },
    /// The Mac and this app speak different versions of the core's protocol.
    #[error("this Mac and this app need the same Sikemux release")]
    Outdated { mac_is_older: bool },
}

fn invalid(message: impl ToString) -> MobileError {
    MobileError::Invalid {
        message: message.to_string(),
    }
}

impl From<ClientError> for MobileError {
    fn from(error: ClientError) -> Self {
        match error {
            ClientError::Core(message) => MobileError::Refused { message },
            ClientError::VersionMismatch { version, .. } => MobileError::Outdated {
                mac_is_older: version < PROTOCOL_VERSION,
            },
            other => MobileError::Connection {
                message: other.to_string(),
            },
        }
    }
}

impl From<PairError> for MobileError {
    fn from(error: PairError) -> Self {
        match error {
            PairError::Refused(message) => MobileError::Refused { message },
            PairError::WrongCode => MobileError::WrongCode,
            PairError::Connection(message) => MobileError::Connection { message },
        }
    }
}

/// A new device key. The app keeps it in the Keychain or Keystore; it is the
/// device's identity to every Mac it pairs with.
#[uniffi::export]
pub fn new_device_key() -> Vec<u8> {
    SecretKey::generate().to_bytes().to_vec()
}

#[derive(uniffi::Record)]
pub struct PairingLink {
    pub core: String,
    pub code: String,
}

/// Reads the link a Mac's pairing QR code holds.
#[uniffi::export]
pub fn parse_pairing_link(text: String) -> Option<PairingLink> {
    pairing::PairingLink::parse(&text).map(|link| PairingLink {
        core: link.core.to_string(),
        code: link.code,
    })
}

/// This phone on the network, known by its key.
#[derive(uniffi::Object)]
pub struct Device {
    endpoint: Endpoint,
}

fn core_addr(core: &str) -> Result<EndpointAddr, MobileError> {
    Ok(EndpointAddr::new(core.parse().map_err(invalid)?))
}

#[uniffi::export]
impl Device {
    /// Comes online with the key from [`new_device_key`].
    #[uniffi::constructor]
    pub async fn create(key: Vec<u8>) -> Result<Arc<Self>, MobileError> {
        let bytes: [u8; 32] = key
            .try_into()
            .map_err(|_| invalid("a device key is 32 bytes"))?;
        let endpoint = on_runtime(async move {
            Endpoint::builder(presets::N0)
                .secret_key(SecretKey::from_bytes(&bytes))
                .bind()
                .await
        })
        .await
        .map_err(|error| MobileError::Connection {
            message: error.to_string(),
        })?;
        Ok(Arc::new(Self { endpoint }))
    }

    /// The key Macs know this phone by.
    pub fn id(&self) -> String {
        self.endpoint.id().to_string()
    }

    /// Pairs with the Mac whose key is `core`, waiting while the person
    /// there decides. Answers with the access they gave: `full` or `watch`.
    pub async fn pair(
        &self,
        core: String,
        code: String,
        name: String,
        platform: String,
    ) -> Result<String, MobileError> {
        let endpoint = self.endpoint.clone();
        let addr = core_addr(&core)?;
        let access = on_runtime(async move {
            let request = PairingRequest {
                code: &code,
                name: &name,
                platform: &platform,
            };
            pairing::pair(&endpoint, addr, request).await
        })
        .await?;
        serde_json::to_value(access)
            .ok()
            .and_then(|value| value.as_str().map(str::to_owned))
            .ok_or_else(|| invalid("the Mac gave an access this app does not know"))
    }

    /// Opens a session with a Mac this phone paired with. Everything the core
    /// sends unasked arrives on `listener`.
    pub async fn connect(
        &self,
        core: String,
        listener: Arc<dyn CoreListener>,
    ) -> Result<Arc<Connection>, MobileError> {
        let endpoint = self.endpoint.clone();
        let addr = core_addr(&core)?;
        let sink = Arc::new(ListenerSink(listener));
        let client =
            on_runtime(async move { remote::connect_with(&endpoint, addr, sink).await }).await?;
        Ok(Arc::new(Connection {
            client: Mutex::new(Some(Arc::new(client))),
        }))
    }
}

/// What the core sends a phone without being asked.
#[uniffi::export(with_foreign)]
pub trait CoreListener: Send + Sync {
    /// Terminal bytes for a session the phone attached to. Pass their length
    /// back to [`Connection::ack`] once shown.
    fn output(&self, session: u64, bytes: Vec<u8>);
    /// One of the core's events, as protocol JSON.
    fn event(&self, json: String);
    fn closed(&self);
}

struct ListenerSink(Arc<dyn CoreListener>);

impl EventSink for ListenerSink {
    fn output(&self, id: SessionId, bytes: &[u8]) {
        self.0.output(id, bytes.to_vec());
    }

    fn event(&self, event: Event) {
        if let Ok(json) = serde_json::to_string(&event) {
            self.0.event(json);
        }
    }

    fn window_call(&self, _call_id: CallId, _call: WindowCall) {}

    fn closed(&self) {
        self.0.closed();
    }
}

#[derive(uniffi::Record)]
pub struct AttachedScreen {
    /// Bytes that redraw the terminal as it is now; live output follows.
    pub replay: Vec<u8>,
    pub alternate_screen: bool,
    pub exited: bool,
}

/// An open session with one Mac's core.
#[derive(uniffi::Object)]
pub struct Connection {
    client: Mutex<Option<Arc<CoreClient>>>,
}

impl Connection {
    fn client(&self) -> Result<Arc<CoreClient>, MobileError> {
        self.client
            .lock()
            .ok()
            .and_then(|client| client.clone())
            .ok_or(MobileError::Connection {
                message: "the connection to the Mac is closed".into(),
            })
    }
}

#[uniffi::export]
impl Connection {
    /// Sends one protocol request, as JSON, and answers with the core's
    /// response, as JSON.
    pub async fn request(&self, json: String) -> Result<String, MobileError> {
        let request: Request = serde_json::from_str(&json).map_err(invalid)?;
        let client = self.client()?;
        let reply = on_runtime(async move {
            match client.submit(request, |reply| reply) {
                Ok(answer) => answer.await,
                Err(error) => Err(error),
            }
        })
        .await??;
        match reply {
            Reply::Response(response) => serde_json::to_string(&response).map_err(invalid),
            Reply::Attached(_) => Err(invalid("use attach for a terminal's screen")),
        }
    }

    pub async fn attach(&self, session: u64) -> Result<AttachedScreen, MobileError> {
        let client = self.client()?;
        let attached = on_runtime(async move { client.attach(session).await }).await?;
        Ok(AttachedScreen {
            replay: attached.replay,
            alternate_screen: attached.alternate_screen,
            exited: attached.exited,
        })
    }

    pub async fn write(&self, session: u64, bytes: Vec<u8>) -> Result<(), MobileError> {
        let client = self.client()?;
        Ok(on_runtime(async move { client.write(session, &bytes).await }).await?)
    }

    pub async fn resize(&self, session: u64, cols: u16, rows: u16) -> Result<(), MobileError> {
        let client = self.client()?;
        Ok(on_runtime(async move { client.resize(session, cols, rows).await }).await?)
    }

    /// Says the phone has shown this many of a session's output bytes, so the
    /// core sends more.
    pub fn ack(&self, session: u64, bytes: u64) -> Result<(), MobileError> {
        self.client()?.ack(session, bytes as usize);
        Ok(())
    }

    pub fn is_open(&self) -> bool {
        self.client().is_ok_and(|client| client.is_connected())
    }

    pub fn close(&self) {
        if let Ok(mut client) = self.client.lock() {
            client.take();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_device_key_is_32_bytes_and_new_each_time() {
        let key = new_device_key();
        assert_eq!(key.len(), 32);
        assert_ne!(key, new_device_key());
    }

    #[test]
    fn a_pairing_link_from_the_mac_reads_back() {
        let core = SecretKey::generate().public();
        let text = pairing::PairingLink {
            core,
            code: "482913".into(),
        }
        .to_url();
        let link = parse_pairing_link(text).expect("a link");
        assert_eq!(link.core, core.to_string());
        assert_eq!(link.code, "482913");
        assert!(parse_pairing_link("https://example.com".into()).is_none());
    }
}

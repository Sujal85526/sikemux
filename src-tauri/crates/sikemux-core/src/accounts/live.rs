//! A host's live connection to its account at `/v1/live`. The server pushes
//! what changed on the account; the host proves its key on every connection,
//! applies each event once, acknowledges it, and reconnects when the
//! connection drops.

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio::sync::watch;
use tokio_websockets::{ClientBuilder, Connector, MaybeTlsStream, Message, WebSocketStream};

use super::protocol::{
    AccountEvent, LiveAck, LiveApp, LiveDeviceMessage, LiveHello, LiveLeave, LivePong, LiveRole,
    LiveServerMessage, RevokeReason,
};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const CHALLENGE_WAIT: Duration = Duration::from_secs(10);
/// The server pings every 25 s; this long without a frame means the
/// connection is dead even if the network has not said so.
const SILENCE: Duration = Duration::from_secs(60);
const BACKOFF_BASE: Duration = Duration::from_secs(1);
const BACKOFF_CAP: Duration = Duration::from_secs(5 * 60);
/// Another connection with this key took over, which happens while a core
/// hands over to its replacement. Coming straight back would push it off.
const REPLACED_WAIT: Duration = Duration::from_secs(60);

const CLOSE_WAIT: Duration = Duration::from_secs(2);

const CLOSE_NOT_SIGNED_IN: u16 = 4401;
const CLOSE_REVOKED: u16 = 4403;
const CLOSE_REPLACED: u16 = 4409;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Want {
    /// Signed in: stay connected.
    Stay,
    /// Signed out, but the server has not heard yet: connect, send `leave`.
    Leave,
    Stop,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Link {
    Connecting,
    Live,
    /// The last attempt failed and another is scheduled.
    Offline,
}

/// What the live connection needs from the host it speaks for.
pub trait Account: Send + Sync + 'static {
    /// The device key and its signature over [`super::live_message`] for
    /// `nonce`, which must pass [`super::check_live`].
    fn sign_live(&self, nonce: &str) -> Option<(String, String)>;
    /// Answering [`Want::Stop`] ends the connection for good.
    fn want(&self) -> Want;
    /// The id of the last event applied.
    fn cursor(&self) -> i64;
    /// Applies `events`, oldest first, all newer than the cursor, and moves
    /// the cursor to the last.
    fn apply(&self, events: &[AccountEvent]);
    /// The account's newest event id is `latest`. A cursor beyond it belongs
    /// to history the server no longer has, so it starts over from nothing;
    /// the server sends only what is newer than its own record of this host.
    fn rewind(&self, latest: i64);
    fn link(&self, link: Link);
    /// The server took this device off the account. `None` when it no longer
    /// knows the key at all.
    fn removed(&self, reason: Option<RevokeReason>);
}

/// `base` is the accounts API, `http(s)://host`.
pub fn url(base: &str) -> String {
    let base = base.trim_end_matches('/');
    let base = if let Some(rest) = base.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = base.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        base.to_owned()
    };
    format!("{base}/v1/live")
}

/// Keeps the connection while [`Account::want`] asks for one. `changed`
/// fires when that answer may have changed.
pub async fn run<A: Account>(
    account: Arc<A>,
    url: String,
    app: LiveApp,
    mut changed: watch::Receiver<()>,
) {
    let mut failures: u32 = 0;
    account.link(Link::Connecting);
    loop {
        if changed.has_changed().is_err() || account.want() == Want::Stop {
            return;
        }
        let wait = match session(&*account, &url, &app, &mut changed).await {
            Ended::Done => continue,
            Ended::Retry { hint, was_live } => {
                if was_live {
                    failures = 0;
                }
                failures = failures.saturating_add(1);
                backoff(failures).max(hint.unwrap_or_default())
            }
        };
        account.link(Link::Offline);
        tokio::select! {
            _ = tokio::time::sleep(wait) => {}
            gone = changed.changed() => {
                if gone.is_err() {
                    return;
                }
            }
        }
    }
}

/// Full jitter: anywhere from nothing to the doubled delay, capped.
fn backoff(failures: u32) -> Duration {
    let ceiling = BACKOFF_BASE
        .saturating_mul(1u32 << failures.saturating_sub(1).min(16))
        .min(BACKOFF_CAP);
    let fraction = (uuid::Uuid::new_v4().as_u128() % 1000) as u32;
    ceiling.mul_f64(f64::from(fraction) / 1000.0)
}

enum Ended {
    Done,
    Retry {
        hint: Option<Duration>,
        was_live: bool,
    },
}

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

fn connector() -> &'static Connector {
    static CONNECTOR: OnceLock<Connector> = OnceLock::new();
    CONNECTOR.get_or_init(|| {
        let roots = tokio_rustls::rustls::RootCertStore {
            roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
        };
        let provider = Arc::new(tokio_rustls::rustls::crypto::ring::default_provider());
        match tokio_rustls::rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
        {
            Ok(builder) => Connector::Rustls(tokio_rustls::TlsConnector::from(Arc::new(
                builder.with_root_certificates(roots).with_no_client_auth(),
            ))),
            Err(_) => Connector::Plain,
        }
    })
}

async fn connect(url: &str) -> Option<Socket> {
    let builder = ClientBuilder::new().uri(url).ok()?.connector(connector());
    match tokio::time::timeout(CONNECT_TIMEOUT, builder.connect()).await {
        Ok(Ok((socket, _))) => Some(socket),
        _ => None,
    }
}

async fn send(socket: &mut Socket, message: LiveDeviceMessage) -> bool {
    let Ok(text) = serde_json::to_string(&message) else {
        return false;
    };
    socket.send(Message::text(text)).await.is_ok()
}

enum Frame {
    Server(LiveServerMessage),
    Closed(Option<u16>),
    Other,
}

async fn next_frame(socket: &mut Socket, wait: Duration) -> Frame {
    let message = match tokio::time::timeout(wait, socket.next()).await {
        Ok(Some(Ok(message))) => message,
        _ => return Frame::Closed(None),
    };
    if let Some((code, _)) = message.as_close() {
        return Frame::Closed(Some(code.into()));
    }
    match message.as_text().map(serde_json::from_str) {
        Some(Ok(message)) => Frame::Server(message),
        _ => Frame::Other,
    }
}

async fn session<A: Account>(
    account: &A,
    url: &str,
    app: &LiveApp,
    changed: &mut watch::Receiver<()>,
) -> Ended {
    let retry = |hint, was_live| Ended::Retry { hint, was_live };
    let Some(mut socket) = connect(url).await else {
        return retry(None, false);
    };
    let nonce = loop {
        match next_frame(&mut socket, CHALLENGE_WAIT).await {
            Frame::Server(LiveServerMessage::Challenge(challenge)) => break challenge.nonce,
            Frame::Server(_) | Frame::Other => continue,
            Frame::Closed(_) => return retry(None, false),
        }
    };
    let Some((key, signature)) = account.sign_live(&nonce) else {
        return retry(None, false);
    };
    let hello = LiveDeviceMessage::Hello(LiveHello {
        role: LiveRole::Host,
        key: Some(key),
        signature: Some(signature),
        token: None,
        app: Some(app.clone()),
    });
    if !send(&mut socket, hello).await {
        return retry(None, false);
    }

    let mut ready = false;
    let mut leaving = false;
    let mut hint = None;
    loop {
        let frame = tokio::select! {
            frame = next_frame(&mut socket, SILENCE) => frame,
            gone = changed.changed() => {
                match if gone.is_err() { Want::Stop } else { account.want() } {
                    Want::Stop => {
                        let _ = tokio::time::timeout(CLOSE_WAIT, socket.close()).await;
                        return Ended::Done;
                    }
                    Want::Leave if ready && !leaving => {
                        leaving = send(&mut socket, LiveDeviceMessage::Leave(LiveLeave {})).await;
                    }
                    _ => {}
                }
                continue;
            }
        };
        let message = match frame {
            Frame::Server(message) => message,
            Frame::Other => continue,
            Frame::Closed(code) => {
                return match code {
                    Some(CLOSE_NOT_SIGNED_IN) if !ready => {
                        account.removed(None);
                        Ended::Done
                    }
                    Some(CLOSE_REVOKED) => {
                        account.removed(None);
                        Ended::Done
                    }
                    Some(CLOSE_REPLACED) => retry(Some(REPLACED_WAIT), ready),
                    _ => retry(hint, ready),
                };
            }
        };
        let answered = match message {
            LiveServerMessage::Ready(server) => {
                ready = true;
                account.rewind(server.latest);
                account.link(Link::Live);
                if account.want() == Want::Leave {
                    leaving = true;
                    send(&mut socket, LiveDeviceMessage::Leave(LiveLeave {})).await
                } else {
                    true
                }
            }
            LiveServerMessage::Events(batch) => {
                let Some(last) = batch.events.iter().map(|event| event.id).max() else {
                    continue;
                };
                let cursor = account.cursor();
                let mut fresh: Vec<AccountEvent> = batch
                    .events
                    .into_iter()
                    .filter(|event| event.id > cursor)
                    .collect();
                fresh.sort_by_key(|event| event.id);
                if !fresh.is_empty() {
                    account.apply(&fresh);
                }
                send(&mut socket, LiveDeviceMessage::Ack(LiveAck { id: last })).await
            }
            LiveServerMessage::Reset(reset) => {
                account.rewind(reset.latest);
                true
            }
            LiveServerMessage::Ping(_) => {
                send(&mut socket, LiveDeviceMessage::Pong(LivePong {})).await
            }
            LiveServerMessage::Bye(bye) => {
                hint = Some(Duration::from_millis(
                    u64::try_from(bye.reconnect_after_ms).unwrap_or_default(),
                ));
                true
            }
            LiveServerMessage::Revoked(revoked) => {
                account.removed(Some(revoked.reason));
                return Ended::Done;
            }
            LiveServerMessage::Challenge(_) | LiveServerMessage::Unknown => true,
        };
        if !answered {
            return retry(hint, ready);
        }
    }
}

#[cfg(test)]
mod tests;

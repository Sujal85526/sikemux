//! Paired devices reaching the core from other machines. The core's key, the
//! on/off switch and the trusted devices live in `<socket>.remote.json`, so
//! the dev and release cores keep separate ones.

use std::collections::HashMap;
use std::fs::{DirBuilder, OpenOptions};
use std::future::Future;
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use iroh::endpoint::{presets, Incoming};
use iroh::{Endpoint, SecretKey};
use serde::{Deserialize, Serialize};
use tokio::sync::{oneshot, watch, Notify};
use tokio::task::JoinHandle;

use crate::accounts::live::{self, Link, Want};
use crate::accounts::protocol::{AccountEvent, AccountEventType, LiveApp, Platform, RevokeReason};
use crate::pairing::{PairingLink, CODE_DIGITS, PAIR_ALPN};
use crate::protocol::{
    AccountLink, AccountLinkState, DeviceAccess, DeviceInfo, Event, PairingOffer, PendingDevice,
    RemoteStatus,
};
use crate::remote::CORE_ALPN;

use super::access::Peer;
use super::bonjour;
use super::connection::{blocking, serve_client};
use super::{Core, CoreError, CoreResult, ServerConfig};

const OFFER_LIFETIME_MS: u64 = 5 * 60 * 1000;
/// Wrong codes one pairing code survives before it is withdrawn.
const OFFER_ATTEMPTS: u8 = 5;
/// How long signing out waits for the account to confirm this host left.
#[cfg(not(test))]
const LEAVE_WAIT: Duration = Duration::from_secs(5);
#[cfg(test)]
const LEAVE_WAIT: Duration = Duration::from_millis(300);

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    secret_key: Option<String>,
    enabled: bool,
    devices: Vec<DeviceInfo>,
    owner: Option<String>,
    /// The last account event applied.
    #[serde(default)]
    account_event_id: i64,
    /// The account this host signed out of before the server heard, which
    /// it tells on its next connection.
    #[serde(default)]
    pending_leave: Option<String>,
    /// Why the account let this host go, until it signs in again.
    #[serde(default)]
    removed: Option<Removal>,
}

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Removal {
    reason: Option<RevokeReason>,
    at: u64,
}

impl Stored {
    fn want(&self) -> Want {
        if self.owner.is_some() {
            Want::Stay
        } else if self.pending_leave.is_some() {
            Want::Leave
        } else {
            Want::Stop
        }
    }
}

struct LiveTask {
    task: JoinHandle<()>,
    changed: watch::Sender<()>,
}

struct Running {
    endpoint: Endpoint,
    accept: JoinHandle<()>,
    _advert: Option<bonjour::Advert>,
}

struct Offer {
    code: String,
    expires_at: u64,
    attempts_left: u8,
}

struct Pending {
    device: PendingDevice,
    answer: oneshot::Sender<Option<DeviceAccess>>,
}

#[derive(Default)]
struct Inner {
    path: Option<PathBuf>,
    direct_only: bool,
    secret: Option<SecretKey>,
    stored: Stored,
    running: Option<Running>,
    connected: HashMap<String, usize>,
    offer: Option<Offer>,
    pending: Vec<Pending>,
    accounts_api: Option<String>,
    live: Option<LiveTask>,
    link: Option<(Link, u64)>,
}

impl Inner {
    fn live_offer(&self) -> Option<&Offer> {
        self.offer
            .as_ref()
            .filter(|offer| offer.attempts_left > 0 && offer.expires_at > unix_ms())
    }
}

#[derive(Default)]
pub(crate) struct Remote {
    inner: Mutex<Inner>,
    left: Notify,
}

pub(crate) fn file_path(socket: &Path) -> PathBuf {
    let mut path = socket.as_os_str().to_owned();
    path.push(".remote.json");
    PathBuf::from(path)
}

pub(crate) fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

fn read_stored(path: &Path) -> CoreResult<Stored> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Stored::default()),
        Err(error) => Err(error.into()),
    }
}

fn write_stored(path: &Path, stored: &Stored) -> CoreResult<()> {
    if let Some(parent) = path.parent().filter(|parent| !parent.exists()) {
        DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(parent)?;
    }
    let mut partial = path.as_os_str().to_owned();
    partial.push(".partial");
    let partial = PathBuf::from(partial);
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&partial)?;
    file.write_all(&serde_json::to_vec_pretty(stored)?)?;
    file.sync_all()?;
    std::fs::rename(&partial, path)?;
    Ok(())
}

fn secret_from_hex(text: &str) -> Option<SecretKey> {
    let bytes: [u8; 32] = hex::decode(text).ok()?.try_into().ok()?;
    Some(SecretKey::from_bytes(&bytes))
}

impl Remote {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub(crate) fn is_enabled(&self) -> bool {
        self.lock().stored.enabled
    }

    /// What a paired device may do now, or `None` once it is unpaired or remote
    /// access is off.
    pub(crate) fn access_of(&self, id: &str) -> Option<DeviceAccess> {
        let inner = self.lock();
        if !inner.stored.enabled {
            return None;
        }
        inner
            .stored
            .devices
            .iter()
            .find(|device| device.id == id)
            .map(|device| device.access)
    }

    pub(crate) fn status(&self) -> RemoteStatus {
        let inner = self.lock();
        let mut connected: Vec<String> = inner.connected.keys().cloned().collect();
        connected.sort();
        let addresses = inner
            .running
            .as_ref()
            .map(|running| {
                running
                    .endpoint
                    .addr()
                    .ip_addrs()
                    .map(ToString::to_string)
                    .collect()
            })
            .unwrap_or_default();
        RemoteStatus {
            enabled: inner.stored.enabled,
            core_id: inner
                .secret
                .as_ref()
                .map(|secret| secret.public().to_string())
                .unwrap_or_default(),
            addresses,
            devices: inner.stored.devices.clone(),
            connected,
            pairing: inner
                .live_offer()
                .zip(inner.secret.as_ref())
                .map(|(offer, secret)| PairingOffer {
                    code: offer.code.clone(),
                    expires_at: offer.expires_at,
                    link: PairingLink {
                        core: secret.public(),
                        code: offer.code.clone(),
                    }
                    .to_url(),
                }),
            pending: inner
                .pending
                .iter()
                .map(|pending| pending.device.clone())
                .collect(),
            owner: inner.stored.owner.clone(),
            account: account_link(&inner),
        }
    }

    /// The core's key and its signature over the registration text for
    /// `nonce` and `user_id`, which must be a challenge and an account.
    pub(super) fn sign_registration(
        &self,
        nonce: &str,
        user_id: &str,
    ) -> CoreResult<(String, String)> {
        crate::accounts::check_registration(nonce, user_id).map_err(CoreError::from)?;
        let inner = self.lock();
        let secret = inner
            .secret
            .as_ref()
            .ok_or_else(|| CoreError::from("the core's key has not loaded"))?;
        let key = secret.public().to_string();
        let message = crate::accounts::registration_message(nonce, user_id, &key);
        Ok((key, hex::encode(secret.sign(message.as_bytes()).to_bytes())))
    }

    fn sign_live(&self, nonce: &str) -> Option<(String, String)> {
        crate::accounts::check_live(nonce).ok()?;
        let inner = self.lock();
        let secret = inner.secret.as_ref()?;
        let key = secret.public().to_string();
        let message = crate::accounts::live_message(nonce, &key);
        Some((key, hex::encode(secret.sign(message.as_bytes()).to_bytes())))
    }

    pub(super) fn core_id(&self) -> Option<String> {
        self.lock()
            .secret
            .as_ref()
            .map(|secret| secret.public().to_string())
    }

    pub(super) fn open_offer(&self) -> CoreResult<()> {
        let mut inner = self.lock();
        if !inner.stored.enabled {
            return Err("turn on remote access before pairing a device".into());
        }
        let code = uuid::Uuid::new_v4().as_u128() % 10u128.pow(CODE_DIGITS as u32);
        inner.offer = Some(Offer {
            code: format!("{code:0width$}", width = CODE_DIGITS),
            expires_at: unix_ms() + OFFER_LIFETIME_MS,
            attempts_left: OFFER_ATTEMPTS,
        });
        Ok(())
    }

    pub(super) fn close_offer(&self) {
        self.lock().offer = None;
    }

    /// The open code, spending one of its attempts.
    pub(super) fn attempt(&self) -> Option<String> {
        let mut inner = self.lock();
        inner.live_offer()?;
        let offer = inner.offer.as_mut()?;
        offer.attempts_left -= 1;
        Some(offer.code.clone())
    }

    /// Withdraws `code` once a device has used it, unless another replaced it.
    pub(super) fn spend_offer(&self, code: &str) {
        let mut inner = self.lock();
        if inner.offer.as_ref().is_some_and(|offer| offer.code == code) {
            inner.offer = None;
        }
    }

    pub(super) fn ask(&self, device: PendingDevice) -> oneshot::Receiver<Option<DeviceAccess>> {
        let (answer, answered) = oneshot::channel();
        self.lock().pending.push(Pending { device, answer });
        answered
    }

    /// Adds an allowed device before telling it, so the answer the app gets
    /// back already lists it.
    pub(super) fn answer(&self, id: &str, access: Option<DeviceAccess>) -> CoreResult<()> {
        let pending = {
            let mut inner = self.lock();
            let index = inner
                .pending
                .iter()
                .position(|pending| pending.device.id == id)
                .ok_or_else(|| CoreError::from("that device is no longer waiting"))?;
            inner.pending.remove(index)
        };
        if let Some(access) = access {
            let device = &pending.device;
            if let Err(error) = self.add_device(DeviceInfo {
                id: device.device_id.clone(),
                name: device.name.clone(),
                platform: device.platform.clone(),
                access,
                paired_at: unix_ms(),
                last_seen: None,
            }) {
                let _ = pending.answer.send(None);
                return Err(error);
            }
        }
        let _ = pending.answer.send(access);
        Ok(())
    }

    pub(super) fn forget_pending(&self, id: &str) {
        self.lock()
            .pending
            .retain(|pending| pending.device.id != id);
    }

    fn add_device(&self, device: DeviceInfo) -> CoreResult<()> {
        self.change(|stored| {
            stored.devices.retain(|known| known.id != device.id);
            stored.devices.push(device);
            Ok(())
        })
    }

    fn save(&self, inner: &Inner) -> CoreResult<()> {
        match inner.path.as_deref() {
            Some(path) => write_stored(path, &inner.stored),
            None => Ok(()),
        }
    }

    fn change<T>(&self, edit: impl FnOnce(&mut Stored) -> CoreResult<T>) -> CoreResult<T> {
        let mut inner = self.lock();
        let result = edit(&mut inner.stored)?;
        self.save(&inner)?;
        Ok(result)
    }

    fn note_connected(&self, id: &str, connected: bool) {
        let mut inner = self.lock();
        if connected {
            *inner.connected.entry(id.to_owned()).or_default() += 1;
            let now = unix_ms();
            if let Some(device) = inner
                .stored
                .devices
                .iter_mut()
                .find(|device| device.id == id)
            {
                device.last_seen = Some(now);
            }
            if let Err(error) = self.save(&inner) {
                eprintln!("sikemux core: could not save when a device was last seen: {error}");
            }
        } else if let Some(count) = inner.connected.get_mut(id) {
            *count -= 1;
            if *count == 0 {
                inner.connected.remove(id);
            }
        }
    }
}

fn account_link(inner: &Inner) -> Option<AccountLink> {
    if inner.stored.owner.is_some() {
        let (link, since) = inner.link?;
        let state = match link {
            Link::Connecting => AccountLinkState::Connecting,
            Link::Live => AccountLinkState::Live,
            Link::Offline => AccountLinkState::Offline,
        };
        return Some(AccountLink {
            state,
            reason: None,
            since,
        });
    }
    inner.stored.removed.map(|removal| AccountLink {
        state: AccountLinkState::Removed,
        reason: removal.reason,
        since: removal.at,
    })
}

/// Loads the core's key and devices, listens if remote access was left on,
/// and connects to the account the host is signed in to.
pub(crate) async fn start(core: &Arc<Core>, config: &ServerConfig) {
    let direct_only = config.remote_direct_only;
    let path = file_path(&config.socket);
    let loading = path.clone();
    let loaded = blocking(move || {
        let mut stored = read_stored(&loading)?;
        let secret = match stored.secret_key.as_deref().and_then(secret_from_hex) {
            Some(secret) => secret,
            None => {
                let secret = SecretKey::generate();
                stored.secret_key = Some(hex::encode(secret.to_bytes()));
                write_stored(&loading, &stored)?;
                secret
            }
        };
        Ok((stored, secret))
    })
    .await;
    let (stored, secret) = match loaded {
        Ok(loaded) => loaded,
        Err(error) => {
            eprintln!(
                "sikemux core: remote access is unavailable, {} did not load: {error}",
                path.display()
            );
            return;
        }
    };
    let enabled = stored.enabled;
    {
        let mut inner = core.remote.lock();
        inner.path = Some(path);
        inner.direct_only = direct_only;
        inner.secret = Some(secret);
        inner.stored = stored;
        inner.accounts_api = config.accounts_api.clone();
    }
    ensure_live(core);
    if enabled {
        if let Err(error) = listen(core).await {
            eprintln!("sikemux core: remote access did not start: {error}");
        }
    }
}

async fn listen(core: &Arc<Core>) -> CoreResult<()> {
    let (secret, direct_only) = {
        let inner = core.remote.lock();
        if inner.running.is_some() {
            return Ok(());
        }
        let secret = inner
            .secret
            .clone()
            .ok_or_else(|| CoreError::from("remote access has no key"))?;
        (secret, inner.direct_only)
    };
    let builder = if direct_only {
        Endpoint::builder(presets::Minimal)
            .clear_ip_transports()
            .bind_addr("127.0.0.1:0")
            .map_err(|error| CoreError::from(error.to_string()))?
    } else {
        Endpoint::builder(presets::N0)
    };
    let endpoint = builder
        .secret_key(secret)
        .alpns(vec![CORE_ALPN.to_vec(), PAIR_ALPN.to_vec()])
        .bind()
        .await
        .map_err(|error| CoreError::from(format!("remote access did not start: {error}")))?;
    let accept = tokio::spawn(accept(core.clone(), endpoint.clone()));
    let advert = if direct_only {
        None
    } else {
        let port = endpoint
            .bound_sockets()
            .iter()
            .find(|address| address.is_ipv4())
            .map(|address| address.port());
        port.and_then(|port| bonjour::advertise(&endpoint.id().to_string(), port))
    };
    let mut inner = core.remote.lock();
    if inner.running.is_some() {
        accept.abort();
        return Ok(());
    }
    inner.running = Some(Running {
        endpoint,
        accept,
        _advert: advert,
    });
    Ok(())
}

pub(crate) async fn stop(core: &Arc<Core>) {
    let running = {
        let mut inner = core.remote.lock();
        inner.offer = None;
        inner.pending.clear();
        inner.running.take()
    };
    core.close_device_clients(None);
    if let Some(running) = running {
        running.accept.abort();
        running.endpoint.close().await;
    }
}

pub(crate) async fn set_enabled(core: &Arc<Core>, enabled: bool) -> CoreResult<RemoteStatus> {
    core.remote.change(|stored| {
        stored.enabled = enabled;
        Ok(())
    })?;
    if enabled {
        if let Err(error) = listen(core).await {
            core.remote.change(|stored| {
                stored.enabled = false;
                Ok(())
            })?;
            return Err(error);
        }
    } else {
        stop(core).await;
    }
    Ok(announce(core))
}

pub(crate) fn set_access(core: &Core, id: &str, access: DeviceAccess) -> CoreResult<RemoteStatus> {
    core.remote.change(|stored| {
        let device = stored
            .devices
            .iter_mut()
            .find(|device| device.id == id)
            .ok_or_else(|| CoreError::from("no paired device has that id"))?;
        device.access = access;
        Ok(())
    })?;
    Ok(announce(core))
}

/// Signing in starts the live connection to the account. Signing out sends
/// `leave` on it, now or on the next connection, so the account drops this
/// host; paired devices stay.
pub(crate) async fn set_owner(core: &Arc<Core>, owner: Option<String>) -> CoreResult<RemoteStatus> {
    if let Some(owner) = &owner {
        crate::accounts::check_user_id(owner).map_err(CoreError::from)?;
    }
    let live = core.remote.lock().accounts_api.is_some();
    let leaving = core.remote.change(|stored| {
        match owner {
            Some(owner) => {
                if stored.owner.as_ref() != Some(&owner) {
                    stored.account_event_id = 0;
                }
                stored.owner = Some(owner);
                stored.pending_leave = None;
                stored.removed = None;
            }
            None => {
                if let Some(previous) = stored.owner.take().filter(|_| live) {
                    stored.pending_leave = Some(previous);
                }
            }
        }
        Ok(stored.pending_leave.is_some())
    })?;
    ensure_live(core);
    if leaving {
        let confirmed = async {
            loop {
                let left = core.remote.left.notified();
                if core.remote.lock().stored.pending_leave.is_none() {
                    return;
                }
                left.await;
            }
        };
        let _ = tokio::time::timeout(LEAVE_WAIT, confirmed).await;
    }
    Ok(announce(core))
}

/// Starts the live connection if the host wants one and has none, or wakes
/// the one it has to look again.
fn ensure_live(core: &Arc<Core>) {
    let mut inner = core.remote.lock();
    if let Some(live) = &inner.live {
        let _ = live.changed.send(());
        return;
    }
    let Some(base) = inner.accounts_api.clone() else {
        return;
    };
    if inner.stored.want() == Want::Stop {
        return;
    }
    let (changed, watching) = watch::channel(());
    let app = LiveApp {
        platform: if cfg!(target_os = "macos") {
            Platform::Macos
        } else {
            Platform::Unknown
        },
        version: core.build.version.clone(),
    };
    let account = Arc::new(HostAccount(Arc::downgrade(core)));
    let task = tokio::spawn(live::run(account, live::url(&base), app, watching));
    inner.live = Some(LiveTask { task, changed });
}

pub(crate) fn stop_live(core: &Core) {
    let mut inner = core.remote.lock();
    inner.link = None;
    if let Some(live) = inner.live.take() {
        live.task.abort();
    }
}

/// The host as its live connection sees it.
struct HostAccount(Weak<Core>);

impl live::Account for HostAccount {
    fn sign_live(&self, nonce: &str) -> Option<(String, String)> {
        self.0.upgrade()?.remote.sign_live(nonce)
    }

    fn want(&self) -> Want {
        let Some(core) = self.0.upgrade() else {
            return Want::Stop;
        };
        let want = {
            let mut inner = core.remote.lock();
            let want = inner.stored.want();
            if want == Want::Stop {
                inner.live = None;
                inner.link = None;
            }
            want
        };
        if want == Want::Stop {
            announce(&core);
        }
        want
    }

    fn cursor(&self) -> i64 {
        self.0
            .upgrade()
            .map_or(0, |core| core.remote.lock().stored.account_event_id)
    }

    fn apply(&self, events: &[AccountEvent]) {
        if let Some(core) = self.0.upgrade() {
            apply_events(&core, events);
        }
    }

    fn rewind(&self, latest: i64) {
        let Some(core) = self.0.upgrade() else {
            return;
        };
        if core.remote.lock().stored.account_event_id <= latest {
            return;
        }
        let rewound = core.remote.change(|stored| {
            stored.account_event_id = 0;
            Ok(())
        });
        if let Err(error) = rewound {
            eprintln!("sikemux core: could not save the account's place: {error}");
        }
    }

    fn link(&self, link: Link) {
        let Some(core) = self.0.upgrade() else {
            return;
        };
        let changed = {
            let mut inner = core.remote.lock();
            let changed = inner.link.map(|(current, _)| current) != Some(link);
            if changed {
                inner.link = Some((link, unix_ms()));
            }
            changed
        };
        if changed {
            announce(&core);
        }
    }

    fn removed(&self, reason: Option<RevokeReason>) {
        if let Some(core) = self.0.upgrade() {
            let_go(&core, reason);
            announce(&core);
        }
    }
}

fn revoke_reason(reason: Option<RevokeReason>) -> &'static str {
    match reason {
        Some(RevokeReason::SignedOut) => "it signed out of your account",
        Some(RevokeReason::AccountDeleted) => "your account was deleted",
        _ => "it was removed from your account",
    }
}

/// Forgets each phone the account revoked and lets go of the account if it
/// let go of this host, then moves the cursor past `events`.
fn apply_events(core: &Core, events: &[AccountEvent]) {
    let own = core.remote.core_id();
    let mut revoked = Vec::new();
    let mut released = None;
    for event in events {
        match event.r#type {
            AccountEventType::DeviceRevoked => match event.key.as_deref() {
                Some(key) if Some(key) == own.as_deref() => released = Some(event.reason),
                Some(key) => revoked.push((key.to_owned(), event.reason)),
                None => {}
            },
            AccountEventType::AccountDeleted => {
                released = Some(Some(RevokeReason::AccountDeleted));
            }
            _ => {}
        }
    }
    let last = events.iter().map(|event| event.id).max().unwrap_or(0);
    let forgotten = core.remote.change(|stored| {
        let mut forgotten = Vec::new();
        for (key, reason) in &revoked {
            if let Some(index) = stored.devices.iter().position(|device| &device.id == key) {
                forgotten.push((stored.devices.remove(index), *reason));
            }
        }
        stored.account_event_id = stored.account_event_id.max(last);
        Ok(forgotten)
    });
    let forgotten = forgotten.unwrap_or_else(|error| {
        eprintln!("sikemux core: could not apply what changed on the account: {error}");
        Vec::new()
    });
    {
        let mut inner = core.remote.lock();
        inner.pending.retain(|pending| {
            !revoked
                .iter()
                .any(|(key, _)| *key == pending.device.device_id)
        });
    }
    for (device, reason) in &forgotten {
        core.close_device_clients(Some(&device.id));
        eprintln!(
            "sikemux core: forgot {} ({}): {}",
            if device.name.is_empty() {
                "a device"
            } else {
                &device.name
            },
            device.id.get(..8).unwrap_or(&device.id),
            revoke_reason(*reason)
        );
    }
    if let Some(reason) = released {
        let_go(core, reason);
    }
    announce(core);
}

/// The account no longer has this host: forget it, and keep why until the
/// person signs in again. Paired devices stay.
fn let_go(core: &Core, reason: Option<RevokeReason>) {
    let released = core.remote.change(|stored| {
        if stored.owner.take().is_some() {
            stored.removed = Some(Removal {
                reason,
                at: unix_ms(),
            });
            eprintln!(
                "sikemux core: signed out of the account: {}",
                match reason {
                    Some(RevokeReason::AccountDeleted) => "it was deleted",
                    Some(RevokeReason::SignedOut) => "this host signed out elsewhere",
                    _ => "this host was removed from it",
                }
            );
        }
        stored.pending_leave = None;
        Ok(())
    });
    if let Err(error) = released {
        eprintln!("sikemux core: could not save leaving the account: {error}");
    }
    core.remote.left.notify_waiters();
}

pub(crate) fn revoke(core: &Core, id: &str) -> CoreResult<RemoteStatus> {
    core.remote.change(|stored| {
        stored.devices.retain(|device| device.id != id);
        Ok(())
    })?;
    core.close_device_clients(Some(id));
    Ok(announce(core))
}

/// Tells the app what changed, and answers with the same status.
pub(crate) fn announce(core: &Core) -> RemoteStatus {
    let status = core.remote.status();
    core.broadcast_local(&Event::Remote {
        status: status.clone(),
    });
    status
}

/// Boxed because a client it serves can turn remote access on, which starts
/// this loop.
fn accept(core: Arc<Core>, endpoint: Endpoint) -> Pin<Box<dyn Future<Output = ()> + Send>> {
    Box::pin(async move {
        while let Some(incoming) = endpoint.accept().await {
            tokio::spawn(serve_device(core.clone(), incoming));
        }
    })
}

async fn serve_device(core: Arc<Core>, incoming: Incoming) {
    let Ok(connection) = incoming.await else {
        return;
    };
    if connection.alpn() == PAIR_ALPN {
        super::pairing::serve(core, connection).await;
        return;
    }
    let id = connection.remote_id().to_string();
    if core.remote.access_of(&id).is_none() {
        connection.close(
            crate::remote::NOT_PAIRED.into(),
            b"this device is not paired with this core",
        );
        return;
    }
    let Ok((send, recv)) = connection.accept_bi().await else {
        return;
    };
    core.remote.note_connected(&id, true);
    announce(&core);
    serve_client(
        core.clone(),
        Peer::Device { id: id.clone() },
        Box::new(recv),
        Box::new(send),
    )
    .await;
    core.remote.note_connected(&id, false);
    announce(&core);
    connection.close(0u32.into(), b"");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_file_sits_beside_the_socket() {
        assert_eq!(
            file_path(Path::new("/home/me/.config/sikemux/core.dev.sock")),
            PathBuf::from("/home/me/.config/sikemux/core.dev.sock.remote.json")
        );
    }

    #[test]
    fn the_key_and_devices_survive_a_write_and_read() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested/core.sock.remote.json");
        let secret = SecretKey::generate();
        let stored = Stored {
            secret_key: Some(hex::encode(secret.to_bytes())),
            enabled: true,
            owner: Some("user_2abc".into()),
            account_event_id: 7,
            pending_leave: Some("user_2old".into()),
            removed: None,
            devices: vec![DeviceInfo {
                id: SecretKey::generate().public().to_string(),
                name: "Phone".into(),
                platform: "ios".into(),
                access: DeviceAccess::Watch,
                paired_at: 1,
                last_seen: None,
            }],
        };
        write_stored(&path, &stored).unwrap();
        let read = read_stored(&path).unwrap();
        assert!(read.enabled);
        assert_eq!(read.devices, stored.devices);
        assert_eq!(read.owner.as_deref(), Some("user_2abc"));
        assert_eq!(read.account_event_id, 7);
        assert_eq!(read.pending_leave.as_deref(), Some("user_2old"));
        let key = secret_from_hex(read.secret_key.as_deref().unwrap()).unwrap();
        assert_eq!(key.public(), secret.public());
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    /// The same vector the server's tests verify, so both sides sign and
    /// check exactly the same text.
    #[test]
    fn registrations_sign_the_text_the_server_checks() {
        let vector: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../../server/protocol/vectors/registration.json"
        ))
        .unwrap();
        let text = |name: &str| vector[name].as_str().unwrap().to_owned();
        let remote = Remote::default();
        remote.lock().secret = secret_from_hex(&text("secretKey"));
        let (key, signature) = remote
            .sign_registration(&text("nonce"), &text("userId"))
            .unwrap();
        assert_eq!(key, text("key"));
        assert_eq!(
            crate::accounts::registration_message(&text("nonce"), &text("userId"), &key),
            text("message")
        );
        assert_eq!(signature, text("signature"));
    }

    #[test]
    fn registrations_refuse_text_that_is_not_a_challenge() {
        let remote = Remote::default();
        remote.lock().secret = Some(SecretKey::generate());
        assert!(remote.sign_registration("hello", "user_2abc").is_err());
        assert!(remote
            .sign_registration(&"a".repeat(64), "user_2abc|extra")
            .is_err());
    }

    fn phone(name: &str) -> DeviceInfo {
        DeviceInfo {
            id: SecretKey::generate().public().to_string(),
            name: name.into(),
            platform: "ios".into(),
            access: DeviceAccess::Full,
            paired_at: 1,
            last_seen: None,
        }
    }

    fn event(id: i64, kind: &str, key: Option<&str>, role: &str, reason: &str) -> AccountEvent {
        let mut event = serde_json::json!({ "id": id, "type": kind, "at": "2026-10-03T00:00:00Z" });
        if let Some(key) = key {
            event["key"] = key.into();
            event["role"] = role.into();
            event["reason"] = reason.into();
        }
        serde_json::from_value(event).unwrap()
    }

    /// A core signed in to an account with two paired phones, saving to `dir`.
    fn signed_in(dir: &Path, phones: &[&DeviceInfo]) -> Arc<Core> {
        let core = Core::new(crate::protocol::BuildIdentity::default(), None).unwrap();
        {
            let mut inner = core.remote.lock();
            inner.path = Some(dir.join("core.sock.remote.json"));
            inner.secret = Some(SecretKey::generate());
            inner.stored.owner = Some("user_2abc".into());
            inner.stored.devices = phones.iter().map(|phone| (*phone).clone()).collect();
        }
        core
    }

    fn devices(core: &Core) -> Vec<String> {
        core.remote
            .status()
            .devices
            .into_iter()
            .map(|device| device.name)
            .collect()
    }

    #[tokio::test]
    async fn a_phone_the_account_revoked_is_forgotten_and_its_request_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let (kept, gone) = (phone("Kept"), phone("Gone"));
        let core = signed_in(dir.path(), &[&kept, &gone]);
        let _waiting = core.remote.ask(PendingDevice {
            id: "request-1".into(),
            device_id: gone.id.clone(),
            name: "Gone".into(),
            platform: "ios".into(),
        });
        let events = [
            event(4, "device.revoked", Some(&gone.id), "client", "removed"),
            event(5, "device.added", Some("someone"), "client", "removed"),
            event(6, "added.later", None, "", ""),
        ];
        apply_events(&core, &events);
        apply_events(&core, &events);

        assert_eq!(devices(&core), vec!["Kept"]);
        assert!(core.remote.status().pending.is_empty());
        assert_eq!(core.remote.status().owner.as_deref(), Some("user_2abc"));
        let saved = read_stored(&dir.path().join("core.sock.remote.json")).unwrap();
        assert_eq!(saved.account_event_id, 6);
        assert_eq!(saved.devices, vec![kept]);
    }

    #[tokio::test]
    async fn the_account_letting_go_of_this_host_signs_it_out_and_keeps_its_phones() {
        let dir = tempfile::tempdir().unwrap();
        let kept = phone("Kept");
        let core = signed_in(dir.path(), &[&kept]);
        let own = core.remote.core_id().unwrap();
        apply_events(
            &core,
            &[event(9, "device.revoked", Some(&own), "host", "removed")],
        );

        let status = core.remote.status();
        assert_eq!(status.owner, None);
        assert_eq!(devices(&core), vec!["Kept"]);
        let account = status.account.unwrap();
        assert_eq!(account.state, AccountLinkState::Removed);
        assert_eq!(account.reason, Some(RevokeReason::Removed));

        apply_events(&core, &[event(10, "account.deleted", None, "", "")]);
        let account = core.remote.status().account.unwrap();
        assert_eq!(account.reason, Some(RevokeReason::Removed));
    }

    #[tokio::test]
    async fn a_deleted_account_signs_the_host_out() {
        let dir = tempfile::tempdir().unwrap();
        let core = signed_in(dir.path(), &[]);
        apply_events(&core, &[event(3, "account.deleted", None, "", "")]);
        let status = core.remote.status();
        assert_eq!(status.owner, None);
        assert_eq!(
            status.account.unwrap().reason,
            Some(RevokeReason::AccountDeleted)
        );
        let saved = read_stored(&dir.path().join("core.sock.remote.json")).unwrap();
        assert!(saved.removed.is_some());
    }

    /// Against a stand-in for the accounts server: a phone removed elsewhere
    /// is forgotten while connected, and signing out leaves the account.
    #[tokio::test]
    async fn the_live_connection_revokes_phones_and_signing_out_leaves() {
        use futures_util::{SinkExt, StreamExt};
        use tokio_websockets::{Message, ServerBuilder};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let dir = tempfile::tempdir().unwrap();
        let (kept, gone) = (phone("Kept"), phone("Gone"));
        let core = signed_in(dir.path(), &[&kept, &gone]);
        core.remote.lock().accounts_api = Some(base);
        ensure_live(&core);

        let (stream, _) = listener.accept().await.unwrap();
        let (_, mut socket) = ServerBuilder::new().accept(stream).await.unwrap();
        let send = |value: serde_json::Value| Message::text(value.to_string());
        let nonce = "ab".repeat(32);
        socket
            .send(send(serde_json::json!({ "type": "challenge", "nonce": nonce, "expiresAt": "2026-10-03T00:00:30Z" })))
            .await
            .unwrap();
        let hello = socket.next().await.unwrap().unwrap();
        let hello: serde_json::Value = serde_json::from_str(hello.as_text().unwrap()).unwrap();
        assert_eq!(hello["key"], core.remote.core_id().unwrap());
        socket
            .send(send(
                serde_json::json!({ "type": "ready", "latest": 1, "heartbeatMs": 25000 }),
            ))
            .await
            .unwrap();
        socket
            .send(send(serde_json::json!({ "type": "events", "events": [
                { "id": 1, "type": "device.revoked", "at": "2026-10-03T00:00:00Z", "key": gone.id, "role": "client", "reason": "signed_out" }
            ] })))
            .await
            .unwrap();
        let ack = socket.next().await.unwrap().unwrap();
        assert_eq!(ack.as_text(), Some(r#"{"type":"ack","id":1}"#));
        assert_eq!(devices(&core), vec!["Kept"]);
        assert_eq!(
            core.remote.status().account.unwrap().state,
            AccountLinkState::Live
        );

        let signing_out = tokio::spawn({
            let core = core.clone();
            async move { set_owner(&core, None).await }
        });
        let leave = socket.next().await.unwrap().unwrap();
        assert_eq!(leave.as_text(), Some(r#"{"type":"leave"}"#));
        socket
            .send(send(
                serde_json::json!({ "type": "revoked", "reason": "signed_out" }),
            ))
            .await
            .unwrap();
        let status = tokio::time::timeout(Duration::from_secs(2), signing_out)
            .await
            .expect("signing out waits only for the server")
            .unwrap()
            .unwrap();
        assert_eq!(status.owner, None);
        assert_eq!(status.account, None);
        assert_eq!(devices(&core), vec!["Kept"]);
        assert!(core.remote.lock().stored.pending_leave.is_none());
    }

    #[tokio::test]
    async fn signing_out_offline_keeps_the_leave_for_the_next_connection() {
        let dir = tempfile::tempdir().unwrap();
        let core = signed_in(dir.path(), &[]);
        core.remote.lock().accounts_api = Some("http://127.0.0.1:9".into());
        let status = set_owner(&core, None).await.unwrap();
        assert_eq!(status.owner, None);
        let saved = read_stored(&dir.path().join("core.sock.remote.json")).unwrap();
        assert_eq!(saved.pending_leave.as_deref(), Some("user_2abc"));

        set_owner(&core, Some("user_2new".into())).await.unwrap();
        let saved = read_stored(&dir.path().join("core.sock.remote.json")).unwrap();
        assert_eq!(saved.pending_leave, None);
        stop_live(&core);
    }

    #[test]
    fn a_missing_file_is_remote_access_off_with_no_devices() {
        let dir = tempfile::tempdir().unwrap();
        let stored = read_stored(&dir.path().join("absent.json")).unwrap();
        assert!(!stored.enabled);
        assert!(stored.devices.is_empty());
    }
}

#![cfg(unix)]

use std::path::{Path, PathBuf};
use std::sync::Once;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use iroh::endpoint::presets;
use iroh::{Endpoint, EndpointAddr};
use serde_json::json;
use sikemux_core::client::{probe, ClientError, ClientEvent, CoreClient};
use sikemux_core::protocol::{
    BuildIdentity, DeviceAccess, Event, LaunchIdentity, RemoteStatus, SessionId, SpawnTarget,
    TerminalSpawn,
};
use sikemux_core::remote::{self, SecretKey};
use sikemux_core::server::{self, ServerConfig, ServerError};
use tokio::sync::mpsc::UnboundedReceiver;

const WAIT: Duration = Duration::from_secs(10);

fn init_env() {
    static ENV: Once = Once::new();
    ENV.call_once(|| {
        std::env::set_var("SHELL", "/bin/sh");
        std::env::set_var("PS1", "$ ");
        std::env::remove_var("ENV");
        std::env::remove_var("SIKEMUX_SHELL");
    });
}

struct Device {
    key: SecretKey,
    name: &'static str,
    access: DeviceAccess,
}

impl Device {
    fn new(name: &'static str, access: DeviceAccess) -> Self {
        Self {
            key: SecretKey::generate(),
            name,
            access,
        }
    }

    fn id(&self) -> String {
        self.key.public().to_string()
    }

    async fn endpoint(&self) -> Endpoint {
        Endpoint::builder(presets::Minimal)
            .secret_key(self.key.clone())
            .clear_ip_transports()
            .bind_addr("127.0.0.1:0")
            .expect("loopback address")
            .bind()
            .await
            .expect("device endpoint")
    }
}

struct TestCore {
    _dir: tempfile::TempDir,
    socket: PathBuf,
    thread: Option<JoinHandle<Result<(), ServerError>>>,
}

impl Drop for TestCore {
    fn drop(&mut self) {
        if let Some(thread) = self.thread.take() {
            let socket = self.socket.clone();
            let _ = std::thread::spawn(move || {
                let runtime = tokio::runtime::Runtime::new().expect("runtime");
                runtime.block_on(async {
                    if let Ok((client, _events)) = CoreClient::connect(&socket).await {
                        let _ = client.shutdown(true).await;
                    }
                });
            })
            .join();
            let _ = thread.join();
        }
    }
}

/// A core whose remote access is already on, trusting `devices`.
fn start_core(core_key: &SecretKey, devices: &[&Device]) -> TestCore {
    init_env();
    let dir = tempfile::tempdir().expect("temp dir");
    let socket = dir.path().join("core.sock");
    let stored = json!({
        "secretKey": hex::encode(core_key.to_bytes()),
        "enabled": true,
        "devices": devices.iter().map(|device| json!({
            "id": device.id(),
            "name": device.name,
            "platform": "ios",
            "access": device.access,
            "pairedAt": 1,
            "lastSeen": null,
        })).collect::<Vec<_>>(),
    });
    std::fs::write(
        remote_file(&socket),
        serde_json::to_vec(&stored).expect("remote file"),
    )
    .expect("write the remote file");
    let config = ServerConfig {
        idle_exit: Duration::from_secs(600),
        build: BuildIdentity {
            version: "0.0.0-test".into(),
            ..BuildIdentity::default()
        },
        remote_direct_only: true,
        ..ServerConfig::new(socket.clone())
    };
    let thread = std::thread::spawn(move || server::run(config));
    let deadline = Instant::now() + WAIT;
    while probe(&socket, Duration::from_secs(1)).is_err() {
        assert!(Instant::now() < deadline, "the core never answered");
        std::thread::sleep(Duration::from_millis(5));
    }
    TestCore {
        _dir: dir,
        socket,
        thread: Some(thread),
    }
}

fn remote_file(socket: &Path) -> PathBuf {
    let mut path = socket.as_os_str().to_owned();
    path.push(".remote.json");
    PathBuf::from(path)
}

async fn listening(app: &CoreClient) -> RemoteStatus {
    let deadline = Instant::now() + WAIT;
    loop {
        let status = app.remote_status().await.expect("remote status");
        if !status.addresses.is_empty() {
            return status;
        }
        assert!(Instant::now() < deadline, "remote access never listened");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

fn core_addr(status: &RemoteStatus) -> EndpointAddr {
    let id = status.core_id.parse().expect("core id");
    status
        .addresses
        .iter()
        .fold(EndpointAddr::new(id), |addr, address| {
            addr.with_ip_addr(address.parse().expect("address"))
        })
}

async fn until_status(
    events: &mut UnboundedReceiver<ClientEvent>,
    done: impl Fn(&RemoteStatus) -> bool,
) -> RemoteStatus {
    loop {
        let event = tokio::time::timeout(WAIT, events.recv())
            .await
            .expect("timed out waiting for a remote status")
            .expect("the app's connection closed");
        if let ClientEvent::Event(Event::Remote { status }) = event {
            if done(&status) {
                return status;
            }
        }
    }
}

async fn until_disconnected(client: &CoreClient) {
    let deadline = Instant::now() + WAIT;
    while client.is_connected() {
        assert!(Instant::now() < deadline, "the device stayed connected");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

fn refusal(result: Result<impl std::fmt::Debug, ClientError>) -> String {
    match result {
        Err(ClientError::Core(message)) => message,
        other => panic!("expected the core to refuse, got {other:?}"),
    }
}

fn echo_terminal() -> SpawnTarget {
    SpawnTarget::Terminal(TerminalSpawn {
        cols: 80,
        rows: 24,
        cwd: Some(std::env::temp_dir().to_string_lossy().into_owned()),
        startup: Some("echo remote-hello".into()),
        ..TerminalSpawn::default()
    })
}

async fn until_output(
    client: &CoreClient,
    events: &mut UnboundedReceiver<ClientEvent>,
    id: SessionId,
    needle: &str,
) {
    let mut seen = Vec::new();
    while !String::from_utf8_lossy(&seen).contains(needle) {
        let event = tokio::time::timeout(WAIT, events.recv())
            .await
            .expect("timed out waiting for output")
            .expect("the device's connection closed");
        if let ClientEvent::Output { id: from, bytes } = event {
            client.ack(from, bytes.len());
            if from == id {
                seen.extend_from_slice(&bytes);
            }
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_paired_device_drives_a_terminal_over_the_network() {
    let core_key = SecretKey::generate();
    let phone = Device::new("Phone", DeviceAccess::Full);
    let core = start_core(&core_key, &[&phone]);
    let (app, _app_events) = CoreClient::connect(&core.socket).await.expect("app");
    let status = listening(&app).await;
    assert_eq!(status.core_id, core_key.public().to_string());

    let endpoint = phone.endpoint().await;
    let (client, mut events) = remote::connect(&endpoint, core_addr(&status))
        .await
        .expect("the phone connects");
    let id = client
        .spawn(LaunchIdentity::default(), echo_terminal())
        .await
        .expect("the phone starts a terminal");
    client.attach(id).await.expect("the phone attaches");
    until_output(&client, &mut events, id, "remote-hello").await;
    client.kill(id).await.expect("the phone ends the terminal");

    let status = app.remote_status().await.expect("status");
    assert_eq!(status.connected, vec![phone.id()]);
    let seen = status.devices[0].last_seen.expect("last seen");
    assert!(seen > 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_watching_device_reads_but_cannot_drive_or_reach_the_core() {
    let core_key = SecretKey::generate();
    let watcher = Device::new("Watcher", DeviceAccess::Watch);
    let core = start_core(&core_key, &[&watcher]);
    let (app, _app_events) = CoreClient::connect(&core.socket).await.expect("app");
    let id = app
        .spawn(LaunchIdentity::default(), echo_terminal())
        .await
        .expect("the app starts a terminal");
    let status = listening(&app).await;

    let endpoint = watcher.endpoint().await;
    let (client, _events) = remote::connect(&endpoint, core_addr(&status))
        .await
        .expect("the watcher connects");
    let sessions = client.list().await.expect("the watcher lists sessions");
    assert!(sessions.iter().any(|session| session.id == id));
    assert!(refusal(client.kill(id).await).contains("watch"));
    assert!(refusal(client.write(id, b"exit\n").await).contains("watch"));
    assert!(refusal(client.stop_all().await).contains("only Sikemux on this Mac"));
    assert!(refusal(client.set_remote_access(false).await).contains("only Sikemux on this Mac"));
    assert!(app.list().await.expect("list").iter().any(|s| s.id == id));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_device_the_core_never_paired_with_is_turned_away() {
    let core_key = SecretKey::generate();
    let phone = Device::new("Phone", DeviceAccess::Full);
    let stranger = Device::new("Stranger", DeviceAccess::Full);
    let core = start_core(&core_key, &[&phone]);
    let (app, _app_events) = CoreClient::connect(&core.socket).await.expect("app");
    let status = listening(&app).await;

    let endpoint = stranger.endpoint().await;
    let attempt = remote::connect(&endpoint, core_addr(&status)).await;
    assert!(attempt.is_err(), "a stranger got a session");
    assert!(app
        .remote_status()
        .await
        .expect("status")
        .connected
        .is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn revoking_or_narrowing_a_device_takes_effect_on_its_open_connection() {
    let core_key = SecretKey::generate();
    let phone = Device::new("Phone", DeviceAccess::Full);
    let tablet = Device::new("Tablet", DeviceAccess::Full);
    let core = start_core(&core_key, &[&phone, &tablet]);
    let (app, mut app_events) = CoreClient::connect(&core.socket).await.expect("app");
    let status = listening(&app).await;
    let id = app
        .spawn(LaunchIdentity::default(), echo_terminal())
        .await
        .expect("the app starts a terminal");

    let phone_endpoint = phone.endpoint().await;
    let (phone_client, _phone_events) = remote::connect(&phone_endpoint, core_addr(&status))
        .await
        .expect("the phone connects");
    let tablet_endpoint = tablet.endpoint().await;
    let (tablet_client, _tablet_events) = remote::connect(&tablet_endpoint, core_addr(&status))
        .await
        .expect("the tablet connects");
    until_status(&mut app_events, |status| status.connected.len() == 2).await;

    app.set_device_access(phone.id(), DeviceAccess::Watch)
        .await
        .expect("narrow the phone");
    assert!(refusal(phone_client.kill(id).await).contains("watch"));

    let status = app.revoke_device(tablet.id()).await.expect("revoke");
    assert_eq!(status.devices.len(), 1);
    until_disconnected(&tablet_client).await;
    let again = remote::connect(&tablet_endpoint, core_addr(&status)).await;
    assert!(again.is_err(), "a revoked device reconnected");

    let status = app.set_remote_access(false).await.expect("turn off");
    assert!(!status.enabled);
    assert!(status.addresses.is_empty());
    until_disconnected(&phone_client).await;
    let stored: serde_json::Value =
        serde_json::from_slice(&std::fs::read(remote_file(&core.socket)).expect("remote file"))
            .expect("json");
    assert_eq!(stored["enabled"], json!(false));
    assert_eq!(stored["devices"].as_array().map(Vec::len), Some(1));
}

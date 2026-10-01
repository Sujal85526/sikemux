//! Pairs with a core and talks to it from another machine, the way the phone
//! app will, over the real network.
//!
//! As the Mac, against a core's socket:
//!   remote mac <socket> on | off | code | allow | status
//! As a device, keeping its key in `<key-file>`:
//!   remote device <key-file> pair <core-id> <code>
//!   remote device <key-file> sessions <core-id>

use std::path::Path;
use std::time::Duration;

use iroh::endpoint::presets;
use iroh::{Endpoint, EndpointAddr};
use sikemux_core::client::CoreClient;
use sikemux_core::pairing::{self, PairingRequest};
use sikemux_core::protocol::DeviceAccess;
use sikemux_core::remote::{self, SecretKey};

type Failure = Box<dyn std::error::Error>;

#[tokio::main]
async fn main() -> Result<(), Failure> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let words: Vec<&str> = args.iter().map(String::as_str).collect();
    match words.as_slice() {
        ["mac", socket, action] => mac(Path::new(socket), action).await,
        ["device", key, "pair", core, code] => pair(Path::new(key), core, code).await,
        ["device", key, "sessions", core] => sessions(Path::new(key), core).await,
        _ => Err("usage: remote mac <socket> on|off|code|allow|status | remote device <key-file> pair <core-id> <code> | remote device <key-file> sessions <core-id>".into()),
    }
}

async fn mac(socket: &Path, action: &str) -> Result<(), Failure> {
    let (client, _events) = CoreClient::connect(socket).await?;
    let status = match action {
        "on" => client.set_remote_access(true).await?,
        "off" => client.set_remote_access(false).await?,
        "code" => client.open_pairing().await?,
        "allow" => {
            let status = client.remote_status().await?;
            let waiting = status.pending.first().ok_or("no device is waiting")?;
            client
                .answer_pairing(waiting.id.clone(), true, DeviceAccess::Full)
                .await?
        }
        "status" => client.remote_status().await?,
        other => return Err(format!("unknown action {other}").into()),
    };
    println!("{}", serde_json::to_string_pretty(&status)?);
    Ok(())
}

async fn endpoint(key_file: &Path) -> Result<Endpoint, Failure> {
    let key = match std::fs::read(key_file) {
        Ok(bytes) => {
            SecretKey::from_bytes(&bytes.try_into().map_err(|_| "the key file is damaged")?)
        }
        Err(_) => {
            let key = SecretKey::generate();
            std::fs::write(key_file, key.to_bytes())?;
            key
        }
    };
    let endpoint = Endpoint::builder(presets::N0)
        .secret_key(key)
        .bind()
        .await?;
    tokio::time::timeout(Duration::from_secs(10), endpoint.online()).await?;
    Ok(endpoint)
}

fn core_addr(core: &str) -> Result<EndpointAddr, Failure> {
    Ok(EndpointAddr::new(core.parse()?))
}

async fn pair(key_file: &Path, core: &str, code: &str) -> Result<(), Failure> {
    let endpoint = endpoint(key_file).await?;
    println!("this device is {}; approve it on the Mac", endpoint.id());
    let request = PairingRequest {
        code,
        name: "remote example",
        platform: "macos",
    };
    let access = pairing::pair(&endpoint, core_addr(core)?, request).await?;
    println!("paired with {access:?} access");
    endpoint.close().await;
    Ok(())
}

async fn sessions(key_file: &Path, core: &str) -> Result<(), Failure> {
    let endpoint = endpoint(key_file).await?;
    let started = std::time::Instant::now();
    let (client, _events) = remote::connect(&endpoint, core_addr(core)?).await?;
    println!("connected in {:?}", started.elapsed());
    for session in client.list().await? {
        println!(
            "{} {:?} running={}",
            session.id, session.kind, session.running
        );
    }
    for chat in client.acp_list().await? {
        println!(
            "chat {} {} in {}",
            chat.agent_id,
            chat.provider,
            chat.cwd.display()
        );
    }
    drop(client);
    endpoint.close().await;
    Ok(())
}

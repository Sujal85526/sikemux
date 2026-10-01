include!("src/generated_command_names.rs");

use sha2::{Digest, Sha256};

fn main() {
    record_voice_helper();
    let attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(IPC_COMMANDS));
    tauri_build::try_build(attributes).expect("failed to prepare Sikemux native capabilities");
}

/// The voice helper is published beside each release instead of shipping in the
/// app, which downloads it with the speech model. The app only accepts the exact
/// helper built with it, so its size and hash are recorded here.
fn record_voice_helper() {
    let binaries = std::path::Path::new("binaries");
    std::fs::create_dir_all(binaries).expect("could not create src-tauri/binaries");
    println!("cargo:rerun-if-changed={}", binaries.display());
    let target = std::env::var("TARGET").unwrap_or_default();
    let candidates = [
        format!("sikemux-voice-{target}"),
        "sikemux-voice-universal-apple-darwin".to_string(),
    ];
    for asset in candidates {
        let Ok(bytes) = std::fs::read(binaries.join(&asset)) else {
            continue;
        };
        println!("cargo:rustc-env=SIKEMUX_VOICE_HELPER_ASSET={asset}");
        println!("cargo:rustc-env=SIKEMUX_VOICE_HELPER_SIZE={}", bytes.len());
        println!(
            "cargo:rustc-env=SIKEMUX_VOICE_HELPER_SHA256={}",
            hex::encode(Sha256::digest(&bytes))
        );
        return;
    }
}

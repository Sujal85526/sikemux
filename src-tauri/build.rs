include!("src/generated_command_names.rs");

use sha2::{Digest, Sha256};

fn main() {
    record_voice_helper();
    record_build_identity();
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

fn git(args: &[&str]) -> Option<String> {
    let output = std::process::Command::new("git").args(args).output().ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .filter(|text| !text.is_empty())
}

/// The commit and time this binary was built, which the background core
/// reports so an app can tell which build it is talking to.
fn record_build_identity() {
    let commit = git(&["rev-parse", "--short=12", "HEAD"]).unwrap_or_else(|| "unknown".into());
    let built_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0);
    println!("cargo:rustc-env=SIKEMUX_BUILD_COMMIT={commit}");
    println!("cargo:rustc-env=SIKEMUX_BUILD_TIME={built_at}");
    let head_ref = git(&["symbolic-ref", "-q", "HEAD"]);
    let watched = ["HEAD", "packed-refs"]
        .into_iter()
        .map(str::to_string)
        .chain(head_ref);
    for name in watched {
        if let Some(path) = git(&["rev-parse", "--path-format=absolute", "--git-path", &name]) {
            if std::path::Path::new(&path).exists() {
                println!("cargo:rerun-if-changed={path}");
            }
        }
    }
}

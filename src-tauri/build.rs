include!("src/generated_command_names.rs");

fn main() {
    let attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(IPC_COMMANDS));
    tauri_build::try_build(attributes).expect("failed to prepare Sikemux native capabilities");
}

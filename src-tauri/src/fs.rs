use std::fs;
use std::path::Path;
use std::process::Command;

use base64::{engine::general_purpose, Engine as _};
use serde::Serialize;
use tauri::async_runtime::spawn_blocking;

use crate::error::{AppError, AppResult};

#[derive(Serialize)]
pub struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
}

#[derive(Serialize)]
pub struct FileBlob {
    mime: String,
    data: String,
    size: u64,
}

/// List a directory, directories first then files, both alphabetical.
/// `.git` is hidden; other dotfiles are kept (it's a code editor).
#[tauri::command]
pub async fn read_dir(path: String) -> AppResult<Vec<DirEntry>> {
    spawn_blocking(move || read_dir_sync(path))
        .await
        .map_err(|e| AppError::Other(format!("read_dir join: {e}")))?
}

fn read_dir_sync(path: String) -> AppResult<Vec<DirEntry>> {
    let mut out = Vec::new();
    for entry in fs::read_dir(&path)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == ".git" {
            continue;
        }
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        out.push(DirEntry {
            name,
            path: entry.path().to_string_lossy().into_owned(),
            is_dir,
        });
    }
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

#[tauri::command]
pub async fn read_file(path: String) -> AppResult<String> {
    spawn_blocking(move || fs::read_to_string(&path).map_err(AppError::from))
        .await
        .map_err(|e| AppError::Other(format!("read_file join: {e}")))?
}

const INLINE_TEXT_MAX_BYTES: u64 = 1024 * 1024;

#[tauri::command]
pub async fn read_text_file_limited(path: String) -> AppResult<String> {
    spawn_blocking(move || read_text_file_limited_sync(path))
        .await
        .map_err(|e| AppError::Other(format!("read_text_file_limited join: {e}")))?
}

fn read_text_file_limited_sync(path: String) -> AppResult<String> {
    let meta = fs::metadata(&path)?;
    if meta.len() > INLINE_TEXT_MAX_BYTES {
        return Err(AppError::Fs(format!(
            "{} is too large for inline diff ({})",
            path,
            human_bytes(meta.len())
        )));
    }
    let bytes = fs::read(&path)?;
    if bytes.iter().take(8192).any(|b| *b == 0) {
        return Err(AppError::Fs(format!(
            "{} is binary; inline diff is disabled",
            path
        )));
    }
    String::from_utf8(bytes).map_err(|_| {
        AppError::Fs(format!(
            "{} is not UTF-8 text; inline diff is disabled",
            path
        ))
    })
}

fn human_bytes(bytes: u64) -> String {
    const KB: f64 = 1024.0;
    const MB: f64 = 1024.0 * 1024.0;
    let b = bytes as f64;
    if b >= MB {
        format!("{:.1} MB", b / MB)
    } else if b >= KB {
        format!("{:.1} KB", b / KB)
    } else {
        format!("{bytes} B")
    }
}

#[tauri::command]
pub async fn read_file_base64(path: String) -> AppResult<FileBlob> {
    spawn_blocking(move || read_file_base64_sync(path))
        .await
        .map_err(|e| AppError::Other(format!("read_file_base64 join: {e}")))?
}

fn read_file_base64_sync(path: String) -> AppResult<FileBlob> {
    let bytes = fs::read(&path)?;
    let mime = mime_for_path(&path);
    Ok(FileBlob {
        mime,
        size: bytes.len() as u64,
        data: general_purpose::STANDARD.encode(bytes),
    })
}

fn mime_for_path(path: &str) -> String {
    let ext = Path::new(path)
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "avif" => "image/avif",
        "tif" | "tiff" => "image/tiff",
        _ => "application/octet-stream",
    }
    .to_string()
}

#[tauri::command]
pub async fn write_file(path: String, content: String) -> AppResult<()> {
    spawn_blocking(move || fs::write(&path, content).map_err(AppError::from))
        .await
        .map_err(|e| AppError::Other(format!("write_file join: {e}")))?
}

/// Write a new file, refusing to overwrite an existing path.
#[tauri::command]
pub async fn write_file_new(path: String, content: String) -> AppResult<()> {
    spawn_blocking(move || write_file_new_sync(path, content))
        .await
        .map_err(|e| AppError::Other(format!("write_file_new join: {e}")))?
}

fn write_file_new_sync(path: String, content: String) -> AppResult<()> {
    use std::io::Write;

    let p = std::path::PathBuf::from(&path);
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&p)
        .map_err(AppError::from)?;
    file.write_all(content.as_bytes()).map_err(AppError::from)
}

/// Create an empty file. Fails if it already exists so we never blow away
/// an existing file with a "new file" action. Parent dirs are auto-created
/// so the caller can pass nested paths in one go.
#[tauri::command]
pub async fn create_file(path: String) -> AppResult<()> {
    spawn_blocking(move || create_file_sync(path))
        .await
        .map_err(|e| AppError::Other(format!("create_file join: {e}")))?
}

fn create_file_sync(path: String) -> AppResult<()> {
    let p = std::path::PathBuf::from(&path);
    if p.exists() {
        return Err(AppError::Fs(format!("already exists: {}", path)));
    }
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::File::create(&p).map(|_| ()).map_err(AppError::from)
}

/// Create a directory (and any missing parents). Idempotent — succeeds if
/// the dir already exists, since "new folder" is forgiving.
#[tauri::command]
pub async fn create_dir(path: String) -> AppResult<()> {
    spawn_blocking(move || fs::create_dir_all(&path).map_err(AppError::from))
        .await
        .map_err(|e| AppError::Other(format!("create_dir join: {e}")))?
}

/// Rename / move an entry. Refuses to overwrite an existing path so the
/// rename UI can never silently clobber a file. Caller passes absolute
/// `src` + absolute `dest`.
#[tauri::command]
pub async fn rename_path(src: String, dest: String) -> AppResult<()> {
    spawn_blocking(move || rename_path_sync(src, dest))
        .await
        .map_err(|e| AppError::Other(format!("rename_path join: {e}")))?
}

fn rename_path_sync(src: String, dest: String) -> AppResult<()> {
    let src_p = std::path::PathBuf::from(&src);
    let dest_p = std::path::PathBuf::from(&dest);
    if !src_p.exists() {
        return Err(AppError::Fs(format!("source missing: {}", src)));
    }
    if dest_p.exists() {
        return Err(AppError::Fs(format!(
            "destination already exists: {}",
            dest
        )));
    }
    if let Some(parent) = dest_p.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::rename(&src_p, &dest_p).map_err(AppError::from)
}

/// Copy an external file into a target directory, preserving its basename.
/// If a same-named file already exists we append " (N)" until unique, so
/// Finder-drop never overwrites silently. Returns the final landing path.
#[tauri::command]
pub async fn copy_into_dir(src: String, dir: String) -> AppResult<String> {
    spawn_blocking(move || copy_into_dir_sync(src, dir))
        .await
        .map_err(|e| AppError::Other(format!("copy_into_dir join: {e}")))?
}

fn copy_into_dir_sync(src: String, dir: String) -> AppResult<String> {
    let src_path = std::path::PathBuf::from(&src);
    if !src_path.exists() {
        return Err(AppError::Fs(format!("source missing: {}", src)));
    }
    let name = src_path
        .file_name()
        .ok_or_else(|| AppError::Fs(format!("source has no filename: {}", src)))?
        .to_os_string();
    let dest_dir = std::path::PathBuf::from(&dir);
    fs::create_dir_all(&dest_dir)?;

    let mut candidate = dest_dir.join(&name);
    if candidate.exists() {
        let stem = std::path::Path::new(&name)
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        let ext = std::path::Path::new(&name)
            .extension()
            .map(|s| format!(".{}", s.to_string_lossy()))
            .unwrap_or_default();
        for n in 1..1000 {
            let attempt = dest_dir.join(format!("{stem} ({n}){ext}"));
            if !attempt.exists() {
                candidate = attempt;
                break;
            }
        }
    }
    fs::copy(&src_path, &candidate)?;
    Ok(candidate.to_string_lossy().into_owned())
}

/// Reveal a path in the OS file manager, selecting the entry itself.
/// macOS: `open -R` highlights the file inside its folder in Finder. Other
/// platforms open the containing directory (no portable "select" exists).
#[tauri::command]
pub async fn reveal_in_finder(path: String) -> AppResult<()> {
    spawn_blocking(move || reveal_in_finder_sync(path))
        .await
        .map_err(|e| AppError::Other(format!("reveal_in_finder join: {e}")))?
}

fn reveal_in_finder_sync(path: String) -> AppResult<()> {
    let p = std::path::PathBuf::from(&path);
    if !p.exists() {
        return Err(AppError::Fs(format!("path missing: {}", path)));
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open").arg("-R").arg(&p).status()?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let dir = if p.is_dir() {
            p.clone()
        } else {
            p.parent().map(|d| d.to_path_buf()).unwrap_or_else(|| p.clone())
        };
        Command::new("xdg-open").arg(&dir).status()?;
    }
    Ok(())
}

/// Move a file or directory to the system Trash (recoverable), matching what
/// a manual delete does. macOS uses `NSFileManager trashItemAtURL:` natively —
/// no Finder-automation prompt, the item lands in the Trash. Other platforms
/// fall back to a permanent remove (no portable trash API).
#[tauri::command]
pub async fn delete_path(path: String) -> AppResult<()> {
    spawn_blocking(move || delete_path_sync(path))
        .await
        .map_err(|e| AppError::Other(format!("delete_path join: {e}")))?
}

fn delete_path_sync(path: String) -> AppResult<()> {
    let p = std::path::PathBuf::from(&path);
    if !p.exists() {
        return Err(AppError::Fs(format!("path missing: {}", path)));
    }
    #[cfg(target_os = "macos")]
    {
        trash_macos(&path)?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        if p.is_dir() {
            fs::remove_dir_all(&p)?;
        } else {
            fs::remove_file(&p)?;
        }
    }
    Ok(())
}

/// `[[NSFileManager defaultManager] trashItemAtURL:[NSURL fileURLWithPath:…]
/// resultingItemURL:nil error:&err]`. Raw msg_send (same style as
/// transparency.rs) so we don't need objc2-foundation class features.
#[cfg(target_os = "macos")]
fn trash_macos(path: &str) -> AppResult<()> {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;

    let c = std::ffi::CString::new(path)
        .map_err(|_| AppError::Fs("path contains NUL byte".into()))?;
    unsafe {
        let s: *mut AnyObject = msg_send![objc2::class!(NSString), stringWithUTF8String: c.as_ptr()];
        let url: *mut AnyObject = msg_send![objc2::class!(NSURL), fileURLWithPath: s];
        let fm: *mut AnyObject = msg_send![objc2::class!(NSFileManager), defaultManager];
        let mut err: *mut AnyObject = std::ptr::null_mut();
        let ok: bool = msg_send![
            fm,
            trashItemAtURL: url,
            resultingItemURL: std::ptr::null_mut::<*mut AnyObject>(),
            error: &mut err
        ];
        if !ok {
            let mut msg = String::from("trash failed");
            if !err.is_null() {
                let desc: *mut AnyObject = msg_send![err, localizedDescription];
                if !desc.is_null() {
                    let utf8: *const std::os::raw::c_char = msg_send![desc, UTF8String];
                    if !utf8.is_null() {
                        msg = std::ffi::CStr::from_ptr(utf8).to_string_lossy().into_owned();
                    }
                }
            }
            return Err(AppError::Fs(msg));
        }
    }
    Ok(())
}

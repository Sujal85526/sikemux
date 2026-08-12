use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex, OnceLock, Weak};

use base64::{engine::general_purpose, Engine as _};
use serde::Serialize;
use sha2::{Digest, Sha256};
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

#[derive(Serialize)]
pub struct FileSnapshot {
    content: String,
    version: String,
}

#[derive(Serialize)]
pub struct FileWriteResult {
    version: String,
}

type FileWriteLock = Arc<Mutex<()>>;
type WeakFileWriteLock = Weak<Mutex<()>>;

fn file_write_locks() -> &'static Mutex<HashMap<PathBuf, WeakFileWriteLock>> {
    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, WeakFileWriteLock>>> = OnceLock::new();
    LOCKS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn write_lock_for(path: &Path) -> AppResult<FileWriteLock> {
    let key = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let mut locks = file_write_locks()
        .lock()
        .map_err(|_| AppError::Other("file write lock registry poisoned".into()))?;
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(&key).and_then(Weak::upgrade) {
        return Ok(lock);
    }
    let lock = Arc::new(Mutex::new(()));
    locks.insert(key, Arc::downgrade(&lock));
    Ok(lock)
}

fn content_version(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
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
    spawn_blocking(move || {
        let bytes = read_bounded(Path::new(&path), EDITOR_TEXT_MAX_BYTES)?;
        String::from_utf8(bytes).map_err(|_| AppError::Fs(format!("{path} is not UTF-8 text")))
    })
    .await
    .map_err(|e| AppError::Other(format!("read_file join: {e}")))?
}

/// Read editor text together with an opaque content version. The version is
/// subsequently required by `write_file_versioned`, so external edits cannot
/// be silently replaced by a stale editor buffer.
#[tauri::command]
pub async fn read_file_versioned(path: String) -> AppResult<FileSnapshot> {
    spawn_blocking(move || {
        let path = PathBuf::from(path);
        let lock = write_lock_for(&path)?;
        let _guard = lock
            .lock()
            .map_err(|_| AppError::Other("file write lock poisoned".into()))?;
        let bytes = read_bounded(&path, EDITOR_TEXT_MAX_BYTES)?;
        let version = content_version(&bytes);
        let content = String::from_utf8(bytes)
            .map_err(|_| AppError::Fs(format!("{} is not UTF-8 text", path.display())))?;
        Ok(FileSnapshot { content, version })
    })
    .await
    .map_err(|e| AppError::Other(format!("read_file_versioned join: {e}")))?
}

const INLINE_TEXT_MAX_BYTES: u64 = 1024 * 1024;
const EDITOR_TEXT_MAX_BYTES: u64 = 16 * 1024 * 1024;
const MEDIA_MAX_BYTES: u64 = 64 * 1024 * 1024;

fn read_bounded(path: &Path, max_bytes: u64) -> AppResult<Vec<u8>> {
    let file = fs::File::open(path)?;
    let mut bytes = Vec::with_capacity(file.metadata()?.len().min(max_bytes) as usize);
    file.take(max_bytes + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > max_bytes {
        return Err(AppError::Fs(format!(
            "{} exceeds the {} read limit",
            path.display(),
            human_bytes(max_bytes)
        )));
    }
    Ok(bytes)
}

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
    let bytes = read_bounded(Path::new(&path), INLINE_TEXT_MAX_BYTES)?;
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
    let bytes = read_bounded(Path::new(&path), MEDIA_MAX_BYTES)?;
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
    spawn_blocking(move || write_file_atomic(PathBuf::from(path), content.as_bytes()))
        .await
        .map_err(|e| AppError::Other(format!("write_file join: {e}")))?
}

/// Atomically replace an editor file only when its current content still
/// matches the version the editor opened or most recently saved.
#[tauri::command]
pub async fn write_file_versioned(
    path: String,
    content: String,
    expected_version: String,
) -> AppResult<FileWriteResult> {
    spawn_blocking(move || {
        if expected_version.len() != 64
            || !expected_version
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(AppError::BadArg(
                "expected_version must be a SHA-256 hex digest",
            ));
        }
        let path = PathBuf::from(path);
        let lock = write_lock_for(&path)?;
        let _guard = lock
            .lock()
            .map_err(|_| AppError::Other("file write lock poisoned".into()))?;
        write_file_versioned_sync(path, content.as_bytes(), &expected_version)
    })
    .await
    .map_err(|e| AppError::Other(format!("write_file_versioned join: {e}")))?
}

fn version_or_conflict(path: &Path) -> AppResult<String> {
    match read_bounded(path, EDITOR_TEXT_MAX_BYTES) {
        Ok(bytes) => Ok(content_version(&bytes)),
        Err(AppError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
            Err(AppError::FileConflict(format!(
                "{} was deleted or moved outside Sikemux",
                path.display()
            )))
        }
        Err(error) => Err(error),
    }
}

fn write_file_versioned_sync(
    path: PathBuf,
    content: &[u8],
    expected_version: &str,
) -> AppResult<FileWriteResult> {
    let target = fs::canonicalize(&path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            AppError::FileConflict(format!(
                "{} was deleted or moved outside Sikemux",
                path.display()
            ))
        } else {
            AppError::from(error)
        }
    })?;
    let actual_version = version_or_conflict(&target)?;
    if actual_version != expected_version {
        return Err(AppError::FileConflict(format!(
            "{} changed outside Sikemux; reload it before saving",
            path.display()
        )));
    }

    let parent = target
        .parent()
        .ok_or_else(|| AppError::Fs("invalid file path".into()))?;
    let existing_permissions = fs::metadata(&target)?.permissions();
    let mut temp = tempfile::NamedTempFile::new_in(parent)?;
    temp.as_file().set_permissions(existing_permissions)?;
    temp.write_all(content)?;
    temp.flush()?;
    temp.as_file().sync_all()?;

    // Re-check after the temporary file is durable. This narrows the external
    // writer race to the final atomic replacement rather than the full write.
    let latest_version = version_or_conflict(&target)?;
    if latest_version != expected_version {
        return Err(AppError::FileConflict(format!(
            "{} changed while Sikemux was saving; no editor bytes were written",
            path.display()
        )));
    }

    temp.persist(&target).map_err(|e| AppError::from(e.error))?;
    #[cfg(unix)]
    fs::File::open(parent)?.sync_all()?;
    Ok(FileWriteResult {
        version: content_version(content),
    })
}

pub(crate) fn write_file_atomic(path: PathBuf, content: &[u8]) -> AppResult<()> {
    // Preserve an existing symlink by replacing its resolved target instead
    // of replacing the symlink itself with a regular file.
    let target = fs::canonicalize(&path).unwrap_or(path);
    let parent = target
        .parent()
        .ok_or_else(|| AppError::Fs("invalid file path".into()))?;
    fs::create_dir_all(parent)?;
    let existing_permissions = fs::metadata(&target).ok().map(|meta| meta.permissions());
    let mut temp = tempfile::NamedTempFile::new_in(parent)?;
    if let Some(permissions) = existing_permissions {
        temp.as_file().set_permissions(permissions)?;
    }
    temp.write_all(content)?;
    temp.flush()?;
    temp.as_file().sync_all()?;
    temp.persist(&target).map_err(|e| AppError::from(e.error))?;
    #[cfg(unix)]
    fs::File::open(parent)?.sync_all()?;
    Ok(())
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
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&p)
        .map(|_| ())
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                AppError::Fs(format!("already exists: {path}"))
            } else {
                AppError::from(error)
            }
        })
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
    if let Some(parent) = dest_p.parent() {
        fs::create_dir_all(parent)?;
    }
    rename_no_replace(&src_p, &dest_p).map_err(|error| {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            AppError::Fs(format!("destination already exists: {dest}"))
        } else {
            AppError::from(error)
        }
    })
}

#[cfg(unix)]
fn rename_no_replace(src: &Path, dest: &Path) -> std::io::Result<()> {
    use rustix::fs::{renameat_with, RenameFlags, CWD};
    renameat_with(CWD, src, CWD, dest, RenameFlags::NOREPLACE).map_err(std::io::Error::from)
}

#[cfg(windows)]
fn rename_no_replace(src: &Path, dest: &Path) -> std::io::Result<()> {
    // Windows MoveFile semantics refuse an existing destination unless the
    // replace flag is explicitly requested; std::fs::rename does not request it.
    fs::rename(src, dest)
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

    let stem = std::path::Path::new(&name)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let ext = std::path::Path::new(&name)
        .extension()
        .map(|s| format!(".{}", s.to_string_lossy()))
        .unwrap_or_default();

    for n in 0..1000 {
        let candidate = if n == 0 {
            dest_dir.join(&name)
        } else {
            dest_dir.join(format!("{stem} ({n}){ext}"))
        };
        let mut destination = match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(AppError::from(error)),
        };
        let copy_result = (|| -> std::io::Result<()> {
            let mut source = fs::File::open(&src_path)?;
            std::io::copy(&mut source, &mut destination)?;
            destination.sync_all()
        })();
        if let Err(error) = copy_result {
            drop(destination);
            let _ = fs::remove_file(&candidate);
            return Err(AppError::from(error));
        }
        return Ok(candidate.to_string_lossy().into_owned());
    }

    Err(AppError::Fs(format!(
        "no available destination name for {} after 1000 attempts",
        name.to_string_lossy()
    )))
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
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer.exe")
            .arg("/select,")
            .arg(&p)
            .status()?;
    }
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        let dir = if p.is_dir() {
            p.clone()
        } else {
            p.parent()
                .map(|d| d.to_path_buf())
                .unwrap_or_else(|| p.clone())
        };
        Command::new("xdg-open").arg(&dir).status()?;
    }
    Ok(())
}

/// Move a file or directory to the platform's recoverable Trash/Recycle Bin.
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
    trash::delete(&p).map_err(|error| AppError::Fs(error.to_string()))?;
    Ok(())
}

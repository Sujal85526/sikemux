use std::fs;

use serde::Serialize;
use tauri::async_runtime::spawn_blocking;

use crate::error::{AppError, AppResult};

#[derive(Serialize)]
pub struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
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

#[tauri::command]
pub async fn write_file(path: String, content: String) -> AppResult<()> {
    spawn_blocking(move || fs::write(&path, content).map_err(AppError::from))
        .await
        .map_err(|e| AppError::Other(format!("write_file join: {e}")))?
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

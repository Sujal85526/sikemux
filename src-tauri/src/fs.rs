use std::fs;

use serde::Serialize;

#[derive(Serialize)]
pub struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
}

/// List a directory, directories first then files, both alphabetical.
/// `.git` is hidden; other dotfiles are kept (it's a code editor).
#[tauri::command]
pub fn read_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let mut out = Vec::new();
    for entry in fs::read_dir(&path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
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
pub fn read_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn write_file(path: String, content: String) -> Result<(), String> {
    fs::write(&path, content).map_err(|e| e.to_string())
}

/// Create an empty file. Fails if it already exists so we never blow away
/// an existing file with a "new file" action. Parent dirs are auto-created
/// so the caller can pass nested paths in one go.
#[tauri::command]
pub fn create_file(path: String) -> Result<(), String> {
    let p = std::path::PathBuf::from(&path);
    if p.exists() {
        return Err(format!("already exists: {}", path));
    }
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::File::create(&p).map(|_| ()).map_err(|e| e.to_string())
}

/// Create a directory (and any missing parents). Idempotent — succeeds if
/// the dir already exists, since "new folder" is forgiving.
#[tauri::command]
pub fn create_dir(path: String) -> Result<(), String> {
    fs::create_dir_all(&path).map_err(|e| e.to_string())
}

/// Rename / move an entry. Refuses to overwrite an existing path so the
/// rename UI can never silently clobber a file. Caller passes absolute
/// `src` + absolute `dest`.
#[tauri::command]
pub fn rename_path(src: String, dest: String) -> Result<(), String> {
    let src_p = std::path::PathBuf::from(&src);
    let dest_p = std::path::PathBuf::from(&dest);
    if !src_p.exists() {
        return Err(format!("source missing: {}", src));
    }
    if dest_p.exists() {
        return Err(format!("destination already exists: {}", dest));
    }
    if let Some(parent) = dest_p.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::rename(&src_p, &dest_p).map_err(|e| e.to_string())
}

/// Copy an external file into a target directory, preserving its basename.
/// If a same-named file already exists we append " (N)" until unique, so
/// Finder-drop never overwrites silently. Returns the final landing path.
#[tauri::command]
pub fn copy_into_dir(src: String, dir: String) -> Result<String, String> {
    let src_path = std::path::PathBuf::from(&src);
    if !src_path.exists() {
        return Err(format!("source missing: {}", src));
    }
    let name = src_path
        .file_name()
        .ok_or_else(|| format!("source has no filename: {}", src))?
        .to_os_string();
    let dest_dir = std::path::PathBuf::from(&dir);
    fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;

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
    fs::copy(&src_path, &candidate).map_err(|e| e.to_string())?;
    Ok(candidate.to_string_lossy().into_owned())
}

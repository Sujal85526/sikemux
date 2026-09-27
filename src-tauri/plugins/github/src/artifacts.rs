// What a run left behind, and putting one on disk. GitHub serves an artifact
// as a zip behind a redirect, and stops serving it at all once it expires.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::client;
use crate::error::{ActionsError, ActionsResult};
use crate::runs::RunRef;
use crate::workflows::RepoRef;

const MAX_PER_PAGE: u32 = 100;

#[derive(Deserialize)]
struct ArtifactRow {
    id: u64,
    name: String,
    size_in_bytes: u64,
    expired: bool,
    created_at: Option<String>,
    expires_at: Option<String>,
}

#[derive(Deserialize)]
struct ArtifactList {
    artifacts: Vec<ArtifactRow>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    pub id: u64,
    pub name: String,
    pub size_bytes: u64,
    /// True once GitHub has stopped keeping it, which makes it undownloadable.
    pub expired: bool,
    pub created_at: Option<String>,
    pub expires_at: Option<String>,
}

pub async fn list(data_dir: &Path, input: RunRef) -> ActionsResult<Vec<Artifact>> {
    let path = input
        .repo
        .path(&format!("/actions/runs/{}/artifacts", input.run_id))?;
    let list: ArtifactList =
        client::get(data_dir, &path, &[("per_page", MAX_PER_PAGE.to_string())]).await?;
    Ok(list
        .artifacts
        .into_iter()
        .map(|row| Artifact {
            id: row.id,
            name: row.name,
            size_bytes: row.size_in_bytes,
            expired: row.expired,
            created_at: row.created_at,
            expires_at: row.expires_at,
        })
        .collect())
}

/// Anything that could steer the file out of the folder it is meant to land
/// in is dropped, so a name GitHub accepted cannot become a path. The name is
/// split on everything a filename may not hold, and the dot-only pieces that
/// walk up a directory go with it.
fn safe_file_name(name: &str) -> String {
    let joined = name
        .split(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')))
        .filter(|part| !part.is_empty() && !part.chars().all(|c| c == '.'))
        .collect::<Vec<_>>()
        .join("-");
    let trimmed = joined.trim_matches(['.', '-']);
    if trimmed.is_empty() {
        "artifact".to_string()
    } else {
        trimmed.chars().take(120).collect()
    }
}

/// Where a download lands: the person's Downloads folder when there is one,
/// and the plugin's own folder otherwise.
fn download_dir(data_dir: &Path) -> PathBuf {
    std::env::var("HOME")
        .ok()
        .map(PathBuf::from)
        .map(|home| home.join("Downloads"))
        .filter(|dir| dir.is_dir())
        .unwrap_or_else(|| data_dir.to_path_buf())
}

/// Never overwrites: a second copy of the same artifact lands beside the first.
fn free_path(dir: &Path, stem: &str) -> PathBuf {
    let candidate = dir.join(format!("{stem}.zip"));
    if !candidate.exists() {
        return candidate;
    }
    for suffix in 2..1000u32 {
        let next = dir.join(format!("{stem}-{suffix}.zip"));
        if !next.exists() {
            return next;
        }
    }
    dir.join(format!("{stem}-{}.zip", std::process::id()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Download {
    #[serde(flatten)]
    pub repo: RepoRef,
    pub artifact_id: u64,
    pub name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Saved {
    pub path: String,
    pub bytes: u64,
}

pub async fn download(data_dir: &Path, input: Download) -> ActionsResult<Saved> {
    let path = input
        .repo
        .path(&format!("/actions/artifacts/{}/zip", input.artifact_id))?;
    let bytes = client::download(data_dir, &path).await?;
    let dir = download_dir(data_dir);
    std::fs::create_dir_all(&dir)
        .map_err(|error| ActionsError::Transport(format!("saving the artifact: {error}")))?;
    let target = free_path(&dir, &safe_file_name(&input.name));
    std::fs::write(&target, &bytes)
        .map_err(|error| ActionsError::Transport(format!("saving the artifact: {error}")))?;
    Ok(Saved {
        path: target.to_string_lossy().into_owned(),
        bytes: bytes.len() as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_name_can_never_become_a_path() {
        assert_eq!(safe_file_name("build output"), "build-output");
        assert_eq!(safe_file_name("../../etc/passwd"), "etc-passwd");
        assert_eq!(safe_file_name("dist/app.tar.gz"), "dist-app.tar.gz");
        assert_eq!(safe_file_name("..."), "artifact");
        assert_eq!(safe_file_name(""), "artifact");
    }

    #[test]
    fn keeps_a_plain_name_as_it_is() {
        assert_eq!(safe_file_name("coverage-report"), "coverage-report");
        assert_eq!(safe_file_name("sikemux_0.4.2.dmg"), "sikemux_0.4.2.dmg");
    }

    #[test]
    fn a_long_name_is_cut_rather_than_refused() {
        assert_eq!(safe_file_name(&"a".repeat(400)).len(), 120);
    }

    #[test]
    fn a_second_download_lands_beside_the_first() {
        let dir = std::env::temp_dir().join(format!("sikemux-gha-art-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let first = free_path(&dir, "build");
        assert!(first.ends_with("build.zip"));
        std::fs::write(&first, b"x").expect("write");
        assert!(free_path(&dir, "build").ends_with("build-2.zip"));
        std::fs::remove_dir_all(&dir).ok();
    }
}

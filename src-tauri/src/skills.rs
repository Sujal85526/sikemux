//! The Skills section of Settings: the Sikemux skills library, and the
//! person's own global skills beside it, which Sikemux never changes unless
//! asked to move one in.

use std::path::{Path, PathBuf};

use serde::Serialize;
use sikemux_core::skills::{self, Skill};
use tauri::{AppHandle, Manager};

use crate::error::{AppError, AppResult};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnSkills {
    agent: &'static str,
    folder: PathBuf,
    skills: Vec<Skill>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillsOverview {
    library: PathBuf,
    skills: Vec<Skill>,
    own: Vec<OwnSkills>,
    /// Names in the library that one of the person's own skills also uses.
    clashes: Vec<String>,
}

fn data_dir(app: &AppHandle) -> AppResult<PathBuf> {
    app.path()
        .app_data_dir()
        .map_err(|error| AppError::Other(format!("app data folder unavailable: {error}")))
}

fn overview(data_dir: &Path, folders: Vec<(&'static str, PathBuf)>) -> SkillsOverview {
    let library = skills::list(data_dir);
    let own: Vec<OwnSkills> = folders
        .into_iter()
        .map(|(agent, folder)| OwnSkills {
            agent,
            skills: skills::list_in(&folder),
            folder,
        })
        .filter(|own| !own.skills.is_empty())
        .collect();
    let clashes = library
        .iter()
        .filter(|skill| {
            own.iter()
                .any(|own| own.skills.iter().any(|theirs| theirs.name == skill.name))
        })
        .map(|skill| skill.name.clone())
        .collect();
    SkillsOverview {
        library: skills::library(data_dir),
        skills: library,
        own,
        clashes,
    }
}

/// Moves one of the person's own skills into the library. Only a skill that
/// sits directly in a known global skills folder can move.
fn adopt(
    data_dir: &Path,
    folders: &[(&'static str, PathBuf)],
    path: &Path,
) -> Result<Skill, String> {
    let known = folders
        .iter()
        .any(|(_, folder)| path.parent() == Some(folder.as_path()));
    if !known {
        return Err(format!(
            "{} is not in an agent's skills folder",
            path.display()
        ));
    }
    let skill = skills::install_folder(data_dir, path)?;
    std::fs::remove_dir_all(path).map_err(|error| {
        format!(
            "{} is in Sikemux now, but its old folder stayed: {error}",
            skill.name
        )
    })?;
    Ok(skill)
}

#[tauri::command]
pub async fn skills_overview(app: AppHandle) -> AppResult<SkillsOverview> {
    let data_dir = data_dir(&app)?;
    tokio::task::spawn_blocking(move || overview(&data_dir, crate::agents::global_skill_folders()))
        .await
        .map_err(|error| AppError::Other(error.to_string()))
}

#[tauri::command]
pub async fn skills_create(
    app: AppHandle,
    name: String,
    description: String,
    body: String,
) -> AppResult<Skill> {
    skills::create(&data_dir(&app)?, &name, &description, &body).map_err(AppError::Other)
}

#[tauri::command]
pub async fn skills_install(
    app: AppHandle,
    source: String,
    subfolder: Option<String>,
) -> AppResult<Skill> {
    let data_dir = data_dir(&app)?;
    tokio::task::spawn_blocking(move || {
        let source = source.trim();
        if source.starts_with('/') {
            skills::install_folder(&data_dir, Path::new(source))
        } else {
            let subfolder = subfolder
                .as_deref()
                .map(str::trim)
                .filter(|path| !path.is_empty());
            skills::install_git(&data_dir, source, subfolder)
        }
    })
    .await
    .map_err(|error| AppError::Other(error.to_string()))?
    .map_err(AppError::Other)
}

#[tauri::command]
pub async fn skills_remove(app: AppHandle, name: String) -> AppResult<()> {
    skills::remove(&data_dir(&app)?, &name).map_err(AppError::Other)
}

#[tauri::command]
pub async fn skills_adopt(app: AppHandle, path: String) -> AppResult<Skill> {
    let data_dir = data_dir(&app)?;
    tokio::task::spawn_blocking(move || {
        adopt(
            &data_dir,
            &crate::agents::global_skill_folders(),
            Path::new(&path),
        )
    })
    .await
    .map_err(|error| AppError::Other(error.to_string()))?
    .map_err(AppError::Other)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_skill(folder: &Path, name: &str) {
        std::fs::create_dir_all(folder.join(name)).unwrap();
        std::fs::write(
            folder.join(name).join("SKILL.md"),
            format!("---\nname: {name}\ndescription: {name} skill\n---\n"),
        )
        .unwrap();
    }

    #[test]
    fn the_overview_shows_both_sides_and_the_names_they_share() {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("data");
        let claude = root.path().join("claude-skills");
        let empty = root.path().join("empty-skills");
        std::fs::create_dir_all(&empty).unwrap();
        skills::create(&data, "deploy", "Deploys", "").unwrap();
        skills::create(&data, "review", "Reviews", "").unwrap();
        write_skill(&claude, "deploy");
        write_skill(&claude, "notes");

        let seen = overview(&data, vec![("Claude", claude.clone()), ("Pi", empty)]);
        assert_eq!(seen.skills.len(), 2);
        assert_eq!(seen.own.len(), 1);
        assert_eq!(seen.own[0].agent, "Claude");
        assert_eq!(seen.own[0].skills.len(), 2);
        assert_eq!(seen.clashes, vec!["deploy".to_string()]);
    }

    #[test]
    fn adopting_moves_a_global_skill_in_and_refuses_anything_else() {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("data");
        let claude = root.path().join("claude-skills");
        write_skill(&claude, "notes");
        let folders = vec![("Claude", claude.clone())];

        assert!(adopt(&data, &folders, &root.path().join("elsewhere/notes")).is_err());
        let skill = adopt(&data, &folders, &claude.join("notes")).unwrap();
        assert_eq!(skill.name, "notes");
        assert!(!claude.join("notes").exists());
        assert_eq!(skills::list(&data).len(), 1);
    }
}

//! Skills that exist only inside Sikemux: folders holding a `SKILL.md`, kept in
//! the app data folder and handed to every agent Sikemux launches. Nothing here
//! writes into an agent's own folders such as `~/.claude/skills`.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

const LIBRARY: &str = "skills";
const CLAUDE_PLUGIN: &str = "skills-plugin";
const SKILL_FILE: &str = "SKILL.md";
const NAME_MAX: usize = 64;
const DESCRIPTION_MAX: usize = 1024;
const BODY_MAX: usize = 200_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    pub name: String,
    pub description: String,
    pub path: PathBuf,
}

/// `<appData>/skills`, where every Sikemux skill lives in a folder of its own.
pub fn library(data_dir: &Path) -> PathBuf {
    data_dir.join(LIBRARY)
}

/// The skills in the library, by name. A folder without a readable `SKILL.md` is left out.
pub fn list(data_dir: &Path) -> Vec<Skill> {
    list_in(&library(data_dir))
}

/// The skills in any skills folder, such as an agent's own `~/.claude/skills`.
pub fn list_in(folder: &Path) -> Vec<Skill> {
    let Ok(entries) = fs::read_dir(folder) else {
        return Vec::new();
    };
    let mut skills: Vec<Skill> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| read_skill(&entry.path()))
        .collect();
    skills.sort_by(|a, b| a.name.cmp(&b.name));
    skills
}

fn read_skill(folder: &Path) -> Option<Skill> {
    let text = fs::read_to_string(folder.join(SKILL_FILE)).ok()?;
    let folder_name = folder.file_name()?.to_str()?.to_string();
    let (name, description) = frontmatter(&text);
    Some(Skill {
        name: name.unwrap_or(folder_name),
        description: description.unwrap_or_default(),
        path: folder.to_path_buf(),
    })
}

/// The `name` and `description` a `SKILL.md` declares between its `---` lines.
pub fn frontmatter(text: &str) -> (Option<String>, Option<String>) {
    let mut lines = text.lines();
    if lines.next().map(str::trim) != Some("---") {
        return (None, None);
    }
    let block: Vec<&str> = lines.take_while(|line| line.trim() != "---").collect();
    (field(&block, "name"), field(&block, "description"))
}

fn field(block: &[&str], key: &str) -> Option<String> {
    let start = block.iter().position(|line| {
        line.split_once(':')
            .is_some_and(|(found, _)| found.trim() == key && !line.starts_with(' '))
    })?;
    let (_, value) = block.get(start)?.split_once(':')?;
    let value = value.trim();
    let text = if value == ">" || value == "|" || value == ">-" || value == "|-" {
        block
            .iter()
            .skip(start + 1)
            .take_while(|line| line.starts_with(' ') || line.is_empty())
            .map(|line| line.trim())
            .collect::<Vec<_>>()
            .join(" ")
    } else {
        unquote(value)
    };
    let text = text.trim().to_string();
    (!text.is_empty()).then_some(text)
}

fn unquote(value: &str) -> String {
    if let Some(inner) = value
        .strip_prefix('"')
        .and_then(|rest| rest.strip_suffix('"'))
    {
        return inner.replace("\\\"", "\"").replace("\\\\", "\\");
    }
    if let Some(inner) = value
        .strip_prefix('\'')
        .and_then(|rest| rest.strip_suffix('\''))
    {
        return inner.replace("''", "'");
    }
    value.to_string()
}

/// A skill name is lowercase letters, digits and single hyphens, as agents require.
pub fn check_name(name: &str) -> Result<(), String> {
    let well_formed = !name.is_empty()
        && name.len() <= NAME_MAX
        && name
            .chars()
            .all(|char| char.is_ascii_lowercase() || char.is_ascii_digit() || char == '-')
        && !name.starts_with('-')
        && !name.ends_with('-')
        && !name.contains("--");
    if well_formed {
        Ok(())
    } else {
        Err(format!(
            "'{name}' is not a skill name: use 1 to {NAME_MAX} lowercase letters, digits and single hyphens, like deploy-preview"
        ))
    }
}

/// Writes a new skill into the library. An existing skill of that name is left alone.
pub fn create(data_dir: &Path, name: &str, description: &str, body: &str) -> Result<Skill, String> {
    check_name(name)?;
    let description = description.split_whitespace().collect::<Vec<_>>().join(" ");
    if description.is_empty() || description.len() > DESCRIPTION_MAX {
        return Err(format!(
            "description must say in 1 to {DESCRIPTION_MAX} characters what the skill does and when to use it"
        ));
    }
    if body.len() > BODY_MAX {
        return Err(format!("body must be at most {BODY_MAX} bytes"));
    }
    let folder = library(data_dir).join(name);
    if folder.exists() {
        return Err(format!(
            "A skill named {name} already exists; remove it first or pick another name"
        ));
    }
    fs::create_dir_all(&folder).map_err(|error| error.to_string())?;
    let quoted = description.replace('\\', "\\\\").replace('"', "\\\"");
    let text = format!(
        "---\nname: {name}\ndescription: \"{quoted}\"\n---\n\n{}\n",
        body.trim()
    );
    fs::write(folder.join(SKILL_FILE), text).map_err(|error| error.to_string())?;
    read_skill(&folder).ok_or_else(|| format!("{name} was written but could not be read back"))
}

/// Copies a skill folder into the library under the name its `SKILL.md` declares.
pub fn install_folder(data_dir: &Path, source: &Path) -> Result<Skill, String> {
    let text = fs::read_to_string(source.join(SKILL_FILE))
        .map_err(|_| format!("{} has no {SKILL_FILE}", source.display()))?;
    let name = match frontmatter(&text).0 {
        Some(name) => name,
        None => source
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default()
            .to_string(),
    };
    check_name(&name)?;
    let folder = library(data_dir).join(&name);
    if folder.exists() {
        return Err(format!(
            "A skill named {name} already exists; remove it first"
        ));
    }
    copy_folder(source, &folder).map_err(|error| error.to_string())?;
    read_skill(&folder).ok_or_else(|| format!("{name} was copied but could not be read back"))
}

fn copy_folder(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        if entry.file_name() == ".git" {
            continue;
        }
        let kind = entry.file_type()?;
        let target = to.join(entry.file_name());
        if kind.is_dir() {
            copy_folder(&entry.path(), &target)?;
        } else if kind.is_file() {
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

/// Clones a Git repository and installs the skill at its root, or in `subfolder` of it.
pub fn install_git(data_dir: &Path, url: &str, subfolder: Option<&str>) -> Result<Skill, String> {
    if !(url.starts_with("https://") || url.starts_with("git@") || url.starts_with("ssh://")) {
        return Err("A Git source must be an https://, ssh:// or git@ URL".into());
    }
    if subfolder.is_some_and(|path| {
        Path::new(path)
            .components()
            .any(|part| !matches!(part, std::path::Component::Normal(_)))
    }) {
        return Err("subfolder must be a plain path inside the repository".into());
    }
    let scratch = data_dir.join(format!(".skill-download-{}", uuid::Uuid::new_v4()));
    let cloned = sikemux_process::user_environment::command("git")
        .args(["clone", "--depth", "1", "--quiet", url])
        .arg(&scratch)
        .output()
        .map_err(|error| format!("git could not run: {error}"));
    let result = cloned.and_then(|output| {
        if !output.status.success() {
            return Err(format!(
                "git clone failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        let source = subfolder.map_or_else(|| scratch.clone(), |path| scratch.join(path));
        install_folder(data_dir, &source)
    });
    let _ = fs::remove_dir_all(&scratch);
    result
}

/// Deletes a skill from the library.
pub fn remove(data_dir: &Path, name: &str) -> Result<(), String> {
    check_name(name)?;
    let folder = library(data_dir).join(name);
    if !folder.join(SKILL_FILE).exists() {
        return Err(format!("No Sikemux skill is named {name}"));
    }
    fs::remove_dir_all(&folder).map_err(|error| error.to_string())
}

/// A Claude Code plugin named `sikemux` whose skills are the library, made
/// ready for `--plugin-dir`. Its skills show in Claude as `sikemux:<name>`.
pub fn claude_plugin(data_dir: &Path) -> std::io::Result<PathBuf> {
    let skills = library(data_dir);
    fs::create_dir_all(&skills)?;
    let plugin = data_dir.join(CLAUDE_PLUGIN);
    let manifest = plugin.join(".claude-plugin");
    fs::create_dir_all(&manifest)?;
    fs::write(
        manifest.join("plugin.json"),
        "{\n  \"name\": \"sikemux\",\n  \"description\": \"Skills made or installed in Sikemux\"\n}\n",
    )?;
    let link = plugin.join("skills");
    if fs::read_link(&link).ok().as_deref() != Some(skills.as_path()) {
        let _ = fs::remove_file(&link);
        #[cfg(unix)]
        std::os::unix::fs::symlink(&skills, &link)?;
    }
    Ok(plugin)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("sikemux-skills-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn names_are_lowercase_words_joined_by_single_hyphens() {
        assert!(check_name("deploy-preview").is_ok());
        assert!(check_name("pdf2").is_ok());
        for bad in [
            "",
            "Deploy",
            "deploy_preview",
            "-deploy",
            "deploy-",
            "a--b",
            "../x",
            &"a".repeat(65),
        ] {
            assert!(check_name(bad).is_err(), "{bad} should be refused");
        }
    }

    #[test]
    fn frontmatter_reads_plain_quoted_and_folded_values() {
        let plain = "---\nname: deploy\ndescription: Ship it\n---\nbody";
        assert_eq!(
            frontmatter(plain),
            (Some("deploy".into()), Some("Ship it".into()))
        );
        let quoted = "---\nname: 'deploy'\ndescription: \"Say \\\"hi\\\"\"\n---\n";
        assert_eq!(
            frontmatter(quoted),
            (Some("deploy".into()), Some("Say \"hi\"".into()))
        );
        let folded =
            "---\nname: deploy\ndescription: >\n  Ships the app\n  to staging\nlicense: MIT\n---\n";
        assert_eq!(
            frontmatter(folded).1.as_deref(),
            Some("Ships the app to staging")
        );
        assert_eq!(frontmatter("# no frontmatter"), (None, None));
    }

    #[test]
    fn a_created_skill_is_listed_and_can_be_removed() {
        let data = scratch();
        let skill = create(
            &data,
            "deploy-preview",
            "Deploys a \"preview\"\nbuild",
            "Run `make preview`.",
        )
        .unwrap();
        assert_eq!(skill.description, "Deploys a \"preview\" build");
        let text = fs::read_to_string(library(&data).join("deploy-preview/SKILL.md")).unwrap();
        assert!(text.starts_with("---\nname: deploy-preview\ndescription: \"Deploys a \\\"preview\\\" build\"\n---\n\nRun `make preview`.\n"));
        assert_eq!(list(&data), vec![skill]);
        assert!(create(&data, "deploy-preview", "again", "").is_err());

        remove(&data, "deploy-preview").unwrap();
        assert!(list(&data).is_empty());
        assert!(remove(&data, "deploy-preview").is_err());
        fs::remove_dir_all(data).unwrap();
    }

    #[test]
    fn create_refuses_a_missing_description() {
        let data = scratch();
        assert!(create(&data, "deploy", "  ", "body").is_err());
        fs::remove_dir_all(data).unwrap();
    }

    #[test]
    fn install_copies_a_folder_under_its_declared_name_without_git_files() {
        let data = scratch();
        let source = data.join("download/whatever");
        fs::create_dir_all(source.join("scripts")).unwrap();
        fs::create_dir_all(source.join(".git")).unwrap();
        fs::write(
            source.join("SKILL.md"),
            "---\nname: pdf-tools\ndescription: Reads PDFs\n---\n",
        )
        .unwrap();
        fs::write(source.join("scripts/run.sh"), "echo hi").unwrap();

        let skill = install_folder(&data, &source).unwrap();
        assert_eq!(skill.name, "pdf-tools");
        assert!(library(&data).join("pdf-tools/scripts/run.sh").exists());
        assert!(!library(&data).join("pdf-tools/.git").exists());
        assert!(install_folder(&data, &source).is_err());
        assert!(install_folder(&data, &data.join("download")).is_err());
        fs::remove_dir_all(data).unwrap();
    }

    #[test]
    fn install_git_refuses_local_paths_and_escaping_subfolders() {
        let data = scratch();
        assert!(install_git(&data, "/tmp/repo", None).is_err());
        assert!(install_git(&data, "https://example.com/repo.git", Some("../x")).is_err());
        fs::remove_dir_all(data).unwrap();
    }

    #[test]
    fn the_claude_plugin_names_itself_sikemux_and_links_the_library() {
        let data = scratch();
        let plugin = claude_plugin(&data).unwrap();
        let manifest = fs::read_to_string(plugin.join(".claude-plugin/plugin.json")).unwrap();
        assert!(manifest.contains("\"name\": \"sikemux\""));
        create(&data, "deploy", "Deploys", "").unwrap();
        assert!(plugin.join("skills/deploy/SKILL.md").exists());
        assert_eq!(claude_plugin(&data).unwrap(), plugin);
        fs::remove_dir_all(data).unwrap();
    }
}

//! Points each agent Sikemux launches at the Sikemux skills library, always by
//! adding to the agent's own skills and never by writing into its folders.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

/// `--plugin-dir` loads the library as a plugin for this session only. One `=`
/// token, because the flag takes a list and would swallow the next plain word.
pub fn claude_args(data_dir: &Path) -> std::io::Result<Vec<String>> {
    let plugin = sikemux_core::skills::claude_plugin(data_dir)?;
    Ok(vec![format!("--plugin-dir={}", plugin.to_string_lossy())])
}

pub fn pi_args(data_dir: &Path) -> Vec<String> {
    vec![
        "--skill".into(),
        sikemux_core::skills::library(data_dir)
            .to_string_lossy()
            .into_owned(),
    ]
}

/// OMP adds the directories a `--config` file lists to its own.
pub fn omp_args(data_dir: &Path) -> std::io::Result<Vec<String>> {
    let library = sikemux_core::skills::library(data_dir);
    std::fs::create_dir_all(&library)?;
    let path = data_dir.join("omp-skills.yml");
    let quoted = serde_json::to_string(&library.to_string_lossy()).unwrap_or_default();
    std::fs::write(
        &path,
        format!("skills:\n  customDirectories:\n    - {quoted}\n"),
    )?;
    Ok(vec!["--config".into(), path.to_string_lossy().into_owned()])
}

/// OpenCode replaces a list set in `OPENCODE_CONFIG_CONTENT` rather than
/// joining it, so the paths from the user's own config ride along.
pub fn add_opencode_paths(config: &mut Value, own_paths: &[String], library: &Path) {
    let Some(root) = config.as_object_mut() else {
        return;
    };
    let skills = root.entry("skills").or_insert_with(|| json!({}));
    let Some(skills) = skills.as_object_mut() else {
        return;
    };
    let mut paths: Vec<String> = skills
        .get("paths")
        .and_then(Value::as_array)
        .map(|paths| {
            paths
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let library = library.to_string_lossy().into_owned();
    for path in own_paths.iter().chain(std::iter::once(&library)) {
        if !paths.contains(path) {
            paths.push(path.clone());
        }
    }
    skills.insert("paths".into(), json!(paths));
}

/// The `skills.paths` in the user's global OpenCode config.
pub fn opencode_own_paths(config_dir: &Path) -> Vec<String> {
    ["opencode.json", "opencode.jsonc"]
        .iter()
        .filter_map(|name| std::fs::read_to_string(config_dir.join(name)).ok())
        .filter_map(|text| serde_json::from_str::<Value>(&plain_json(&text)).ok())
        .flat_map(|config| {
            config
                .pointer("/skills/paths")
                .and_then(Value::as_array)
                .map(|paths| {
                    paths
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default()
        })
        .collect()
}

/// JSON with comments and trailing commas, as OpenCode allows, made plain.
fn plain_json(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    let mut in_string = false;
    while let Some(char) = chars.next() {
        if in_string {
            out.push(char);
            match char {
                '\\' => out.extend(chars.next()),
                '"' => in_string = false,
                _ => {}
            }
            continue;
        }
        match (char, chars.peek()) {
            ('"', _) => {
                in_string = true;
                out.push(char);
            }
            ('/', Some('/')) => {
                for skipped in chars.by_ref() {
                    if skipped == '\n' {
                        out.push('\n');
                        break;
                    }
                }
            }
            ('/', Some('*')) => {
                chars.next();
                let mut last = ' ';
                for skipped in chars.by_ref() {
                    if last == '*' && skipped == '/' {
                        break;
                    }
                    last = skipped;
                }
            }
            (',', _) => {
                let rest: String = chars.clone().collect();
                if !matches!(rest.trim_start().chars().next(), Some('}' | ']')) {
                    out.push(char);
                }
            }
            _ => out.push(char),
        }
    }
    out
}

/// The `skills.external_dirs` a Hermes `config.yaml` already lists, with the
/// library added, ready for `hermes config set`.
pub fn hermes_external_dirs(config_yaml: &str, library: &Path) -> String {
    let mut dirs = yaml_list(config_yaml, "skills", "external_dirs");
    let library = library.to_string_lossy().into_owned();
    if !dirs.contains(&library) {
        dirs.push(library);
    }
    json!(dirs).to_string()
}

/// Reads `parent: { key: [...] }` from YAML in its block or flow form. Hermes
/// writes this file itself, so these two forms cover it.
fn yaml_list(text: &str, parent: &str, key: &str) -> Vec<String> {
    let mut lines = text
        .lines()
        .skip_while(|line| line.trim_end() != format!("{parent}:"));
    if lines.next().is_none() {
        return Vec::new();
    }
    let mut inside = lines.take_while(|line| line.is_empty() || line.starts_with(' '));
    let Some(line) = inside.find(|line| line.trim_start().starts_with(&format!("{key}:"))) else {
        return Vec::new();
    };
    let rest = line
        .trim_start()
        .trim_start_matches(&format!("{key}:"))
        .trim();
    let unquote = |item: &str| item.trim().trim_matches('"').trim_matches('\'').to_string();
    if let Some(flow) = rest
        .strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(']'))
    {
        return flow
            .split(',')
            .map(unquote)
            .filter(|item| !item.is_empty())
            .collect();
    }
    inside
        .map(str::trim)
        .take_while(|line| line.starts_with("- "))
        .filter_map(|line| line.strip_prefix("- "))
        .map(unquote)
        .collect()
}

/// Grok's copied `config.toml` with the library added to `[skills] paths`.
pub fn grok_config(config_toml: &str, library: &Path) -> Result<String, String> {
    let mut config: toml::Table = config_toml.parse().map_err(|error| format!("{error}"))?;
    let skills = config
        .entry("skills")
        .or_insert_with(|| toml::Value::Table(toml::Table::new()));
    let skills = skills
        .as_table_mut()
        .ok_or("[skills] in config.toml is not a table")?;
    let paths = skills
        .entry("paths")
        .or_insert_with(|| toml::Value::Array(Vec::new()));
    let paths = paths
        .as_array_mut()
        .ok_or("skills.paths in config.toml is not a list")?;
    let library = toml::Value::String(library.to_string_lossy().into_owned());
    if !paths.contains(&library) {
        paths.push(library);
    }
    toml::to_string(&config).map_err(|error| error.to_string())
}

pub fn library(data_dir: &Path) -> PathBuf {
    sikemux_core::skills::library(data_dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIBRARY: &str = "/Users/me/Library/Application Support/sikemux/skills";

    #[test]
    fn opencode_keeps_the_users_paths_and_adds_the_library_once() {
        let mut config = json!({ "mcp": {}, "skills": { "paths": ["/inherited"] } });
        add_opencode_paths(
            &mut config,
            &["/own".into(), "/inherited".into()],
            Path::new(LIBRARY),
        );
        add_opencode_paths(&mut config, &[], Path::new(LIBRARY));
        assert_eq!(
            config["skills"]["paths"],
            json!(["/inherited", "/own", LIBRARY])
        );
        assert_eq!(config["mcp"], json!({}));
    }

    #[test]
    fn opencode_jsonc_keeps_its_paths_through_comments_and_trailing_commas() {
        let dir = std::env::temp_dir().join(format!("sikemux-opencode-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("opencode.jsonc"),
            "{\n  // my skills\n  \"skills\": { /* team */ \"paths\": [\"~/team//skills\", \"/a,b\",], },\n}\n",
        )
        .unwrap();
        assert_eq!(
            opencode_own_paths(&dir),
            vec!["~/team//skills".to_string(), "/a,b".to_string()]
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn hermes_keeps_external_dirs_in_either_yaml_form() {
        let block = "model: x\nskills:\n  enabled: true\n  external_dirs:\n    - ~/team-skills\n    - \"/opt/skills\"\nmcp_servers: {}\n";
        assert_eq!(
            hermes_external_dirs(block, Path::new(LIBRARY)),
            json!(["~/team-skills", "/opt/skills", LIBRARY]).to_string()
        );
        let flow = "skills:\n  external_dirs: [~/a, '/b']\n";
        assert_eq!(
            hermes_external_dirs(flow, Path::new(LIBRARY)),
            json!(["~/a", "/b", LIBRARY]).to_string()
        );
        assert_eq!(
            hermes_external_dirs("{}\n", Path::new(LIBRARY)),
            json!([LIBRARY]).to_string()
        );
    }

    #[test]
    fn grok_adds_the_library_to_its_skills_paths_and_keeps_the_rest() {
        let config = "model = \"grok-5\"\n\n[skills]\npaths = [\"/own\"]\n\n[mcp_servers.x]\ncommand = \"x\"\n";
        let merged: toml::Table = grok_config(config, Path::new(LIBRARY))
            .unwrap()
            .parse()
            .unwrap();
        assert_eq!(merged["model"].as_str(), Some("grok-5"));
        assert_eq!(merged["skills"]["paths"].as_array().unwrap().len(), 2);
        assert_eq!(merged["mcp_servers"]["x"]["command"].as_str(), Some("x"));
        let empty: toml::Table = grok_config("", Path::new(LIBRARY))
            .unwrap()
            .parse()
            .unwrap();
        assert_eq!(empty["skills"]["paths"][0].as_str(), Some(LIBRARY));
        assert!(grok_config("skills = 3", Path::new(LIBRARY)).is_err());
    }

    #[test]
    fn omp_gets_a_config_listing_the_library() {
        let data = std::env::temp_dir().join(format!("sikemux-omp-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&data).unwrap();
        let args = omp_args(&data).unwrap();
        assert_eq!(args[0], "--config");
        let text = std::fs::read_to_string(&args[1]).unwrap();
        assert!(text.contains("customDirectories:"));
        assert!(text.contains(&library(&data).to_string_lossy().into_owned()));
        std::fs::remove_dir_all(data).unwrap();
    }

    #[test]
    fn claude_gets_the_plugin_as_one_token() {
        let data = std::env::temp_dir().join(format!("sikemux-claude-{}", uuid::Uuid::new_v4()));
        let args = claude_args(&data).unwrap();
        assert_eq!(args.len(), 1);
        assert!(args[0].starts_with("--plugin-dir=") && args[0].ends_with("skills-plugin"));
        std::fs::remove_dir_all(data).unwrap();
    }
}

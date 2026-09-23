use semver::{Version, VersionReq};
use serde::{Deserialize, Serialize};

use crate::PluginError;

const MAX_ID_LENGTH: usize = 128;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub id: String,
    pub name: String,
    pub version: Version,
    pub sikemux: VersionReq,
    pub group: Group,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Group {
    Cloud,
    CiCd,
    Apis,
    Observability,
}

impl Manifest {
    pub fn from_json(source: &str) -> Result<Self, PluginError> {
        let manifest: Manifest = serde_json::from_str(source)
            .map_err(|error| PluginError::new("manifest", error.to_string()))?;
        if !is_valid_id(&manifest.id) {
            return Err(PluginError::new(
                "manifest",
                format!("`{}` is not a reverse-DNS plugin id", manifest.id),
            ));
        }
        Ok(manifest)
    }

    /// Nightly builds carry a pre-release tag, which a plain range like `>=0.4`
    /// would never match. Plugins target the release line, so compare against
    /// the version with the tag removed.
    pub fn supports(&self, sikemux: &Version) -> bool {
        let release_line = Version::new(sikemux.major, sikemux.minor, sikemux.patch);
        self.sikemux.matches(&release_line)
    }
}

pub fn is_valid_id(id: &str) -> bool {
    if id.is_empty() || id.len() > MAX_ID_LENGTH {
        return false;
    }
    let segments: Vec<&str> = id.split('.').collect();
    segments.len() >= 2 && segments.iter().all(|segment| is_valid_segment(segment))
}

fn is_valid_segment(segment: &str) -> bool {
    let mut bytes = segment.bytes();
    bytes.next().is_some_and(|first| first.is_ascii_lowercase())
        && bytes.all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest(sikemux: &str) -> Result<Manifest, PluginError> {
        Manifest::from_json(&format!(
            r#"{{"id":"sikemux.rundeck","name":"Rundeck","version":"1.0.0","sikemux":"{sikemux}","group":"ci-cd"}}"#
        ))
    }

    #[test]
    fn parses_a_manifest() -> Result<(), PluginError> {
        let manifest = manifest(">=0.4")?;
        assert_eq!(manifest.id, "sikemux.rundeck");
        assert_eq!(manifest.group, Group::CiCd);
        Ok(())
    }

    #[test]
    fn a_nightly_satisfies_its_release_line() -> Result<(), PluginError> {
        let manifest = manifest(">=0.4")?;
        let nightly = Version::parse("0.4.0-nightly.10")
            .map_err(|e| PluginError::new("test", e.to_string()))?;
        let older = Version::parse("0.3.9").map_err(|e| PluginError::new("test", e.to_string()))?;
        assert!(manifest.supports(&nightly));
        assert!(!manifest.supports(&older));
        Ok(())
    }

    #[test]
    fn rejects_ids_that_are_not_reverse_dns() {
        for id in [
            "rundeck",
            "Sikemux.rundeck",
            "sikemux..rundeck",
            "sikemux.1deck",
            "",
        ] {
            assert!(!is_valid_id(id), "{id} should be rejected");
        }
        assert!(is_valid_id("dev.someone.signoz-lite"));
    }

    #[test]
    fn rejects_unknown_fields() {
        let result = Manifest::from_json(
            r#"{"id":"a.b","name":"B","version":"1.0.0","sikemux":"*","group":"apis","extra":1}"#,
        );
        assert!(result.is_err());
    }
}

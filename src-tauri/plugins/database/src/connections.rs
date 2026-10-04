// Reaching a database: trying a connection before it is saved.

use std::path::PathBuf;
use std::time::Instant;

use serde::{Deserialize, Serialize};

use crate::engines::Session;
use crate::error::DatabaseResult;
use crate::profiles::{self, Draft};

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TestRequest {
    pub profile: Draft,
    #[serde(default)]
    pub password: Option<String>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Tested {
    pub version: String,
    pub millis: u64,
}

/// Tries the profile as typed. Editing a saved one without retyping its password uses the saved password.
pub async fn test(data_dir: PathBuf, request: TestRequest) -> DatabaseResult<Tested> {
    let started = Instant::now();
    let TestRequest { profile, password } = request;
    let id = profile.id.clone();
    let password =
        profiles::blocking(move || profiles::password_for(&data_dir, id.as_deref(), password))
            .await?;
    let session = Session::open(&profile.target, password.as_deref(), profile.read_only).await?;
    let version = session.version().await?;
    Ok(Tested {
        version,
        millis: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
    })
}

// Reaching a database: trying a connection before it is saved.

use std::time::Instant;

use serde::{Deserialize, Serialize};

use crate::engines::Session;
use crate::error::DatabaseResult;
use crate::profiles::Draft;

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TestRequest {
    pub profile: Draft,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Tested {
    pub version: String,
    pub millis: u64,
}

pub async fn test(request: TestRequest) -> DatabaseResult<Tested> {
    let started = Instant::now();
    let session = Session::open(&request.profile.target, request.profile.read_only).await?;
    let version = session.version().await?;
    Ok(Tested {
        version,
        millis: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
    })
}

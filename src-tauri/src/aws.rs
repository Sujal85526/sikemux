// AWS master module — view-only dashboard over the user's SSO-configured
// profiles. We shell out to the `aws` CLI for every API call so the heavy
// SDK crates stay out of the binary; the CLI also reuses the user's existing
// SSO token cache (~/.aws/sso/cache/) and ~/.aws/config resolution rules
// (sso_session refs, source_profile chains, region precedence) for free.
//
// Native code in this module is restricted to:
//   - parsing ~/.aws/config to discover profiles + their SSO start URLs
//   - checking sso cache expiry so the status chip doesn't need to fork
//   - a thin response cache (60s) so we don't spam the CLI on every render

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;

// ============================================================
// profile discovery
// ============================================================

#[derive(Serialize, Clone)]
pub struct AwsProfile {
    name: String,
    region: Option<String>,
    /// Identity Center start URL. None for plain credential / role-based
    /// profiles (we still surface those — auth flow just differs).
    sso_start_url: Option<String>,
    sso_region: Option<String>,
    sso_account_id: Option<String>,
    sso_role_name: Option<String>,
    /// Type of credential resolution: "sso", "credentials", "role", "unknown".
    kind: String,
}

fn config_path() -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    Some(PathBuf::from(home).join(".aws/config"))
}

fn credentials_path() -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    Some(PathBuf::from(home).join(".aws/credentials"))
}

/// Parse an INI-style AWS config. Supports both block forms:
///   `[profile X]`     `[default]`     `[sso-session Y]`
/// Returns `(profile_blocks, sso_session_blocks)`.
fn parse_ini(content: &str) -> (HashMap<String, HashMap<String, String>>, HashMap<String, HashMap<String, String>>) {
    let mut profiles: HashMap<String, HashMap<String, String>> = HashMap::new();
    let mut sessions: HashMap<String, HashMap<String, String>> = HashMap::new();
    let mut current: Option<(bool, String)> = None; // (is_sso_session, key)

    for raw in content.lines() {
        let line = raw.split(|c| c == '#' || c == ';').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        if let Some(rest) = line.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
            let body = rest.trim();
            if let Some(name) = body.strip_prefix("profile ") {
                current = Some((false, name.trim().to_string()));
            } else if let Some(name) = body.strip_prefix("sso-session ") {
                current = Some((true, name.trim().to_string()));
            } else if body == "default" {
                current = Some((false, "default".to_string()));
            } else {
                current = None;
            }
            continue;
        }
        let Some((ref is_session, ref key)) = current else { continue };
        let Some((k, v)) = line.split_once('=') else { continue };
        let k = k.trim().to_string();
        let v = v.trim().to_string();
        let bucket = if *is_session {
            sessions.entry(key.clone()).or_default()
        } else {
            profiles.entry(key.clone()).or_default()
        };
        bucket.insert(k, v);
    }
    (profiles, sessions)
}

fn classify(p: &HashMap<String, String>) -> String {
    if p.contains_key("sso_session") || p.contains_key("sso_start_url") {
        "sso".into()
    } else if p.contains_key("role_arn") {
        "role".into()
    } else if p.contains_key("credential_process") {
        "credential_process".into()
    } else {
        "credentials".into()
    }
}

#[tauri::command]
pub fn aws_profiles() -> Vec<AwsProfile> {
    let mut out: Vec<AwsProfile> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    if let Some(path) = config_path() {
        if let Ok(content) = fs::read_to_string(&path) {
            let (profiles, sessions) = parse_ini(&content);
            for (name, p) in profiles {
                // Resolve SSO fields. New-style references an `sso-session`
                // block; old-style inlines start_url + sso_region on the
                // profile itself.
                let session = p
                    .get("sso_session")
                    .and_then(|s| sessions.get(s))
                    .cloned();
                let pick = |key: &str| -> Option<String> {
                    p.get(key).cloned().or_else(|| {
                        session.as_ref().and_then(|s| s.get(key).cloned())
                    })
                };
                let entry = AwsProfile {
                    region: p.get("region").cloned(),
                    sso_start_url: pick("sso_start_url"),
                    sso_region: pick("sso_region"),
                    sso_account_id: p.get("sso_account_id").cloned(),
                    sso_role_name: p.get("sso_role_name").cloned(),
                    kind: classify(&p),
                    name: name.clone(),
                };
                seen.insert(name);
                out.push(entry);
            }
        }
    }

    // Plain ~/.aws/credentials profiles that aren't in config — still listed
    // so non-SSO users see something.
    if let Some(path) = credentials_path() {
        if let Ok(content) = fs::read_to_string(&path) {
            let (creds, _) = parse_ini(&content);
            for (name, _p) in creds {
                if seen.insert(name.clone()) {
                    out.push(AwsProfile {
                        name,
                        region: None,
                        sso_start_url: None,
                        sso_region: None,
                        sso_account_id: None,
                        sso_role_name: None,
                        kind: "credentials".into(),
                    });
                }
            }
        }
    }

    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

// ============================================================
// auth check + sso login spawn
// ============================================================

#[derive(Serialize, Clone)]
pub struct AwsIdentity {
    arn: Option<String>,
    account: Option<String>,
    user_id: Option<String>,
    /// "authed" | "expired" | "no-credentials" | "error" | "cli-missing"
    status: String,
    message: Option<String>,
}

fn id_cache() -> &'static Mutex<HashMap<String, (Instant, AwsIdentity)>> {
    static C: OnceLock<Mutex<HashMap<String, (Instant, AwsIdentity)>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

const ID_TTL: Duration = Duration::from_secs(60);

fn run_aws_cli(args: &[&str], profile: Option<&str>) -> Result<(bool, String, String), String> {
    let bin = std::env::var("AWS_CLI").unwrap_or_else(|_| "aws".to_string());
    let mut cmd = Command::new(&bin);
    if let Some(p) = profile {
        cmd.env("AWS_PROFILE", p);
    }
    cmd.env("AWS_PAGER", "").env("NO_COLOR", "1");
    cmd.args(args);
    let out = cmd.output().map_err(|e| e.to_string())?;
    Ok((
        out.status.success(),
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    ))
}

#[tauri::command]
pub async fn aws_caller_identity(profile: String, force: bool) -> AwsIdentity {
    if !force {
        if let Some(cached) = id_cache()
            .lock()
            .ok()
            .and_then(|c| c.get(&profile).cloned())
        {
            if cached.0.elapsed() < ID_TTL {
                return cached.1;
            }
        }
    }

    let result = run_aws_cli(
        &["sts", "get-caller-identity", "--output", "json"],
        Some(&profile),
    );
    let id = match result {
        Err(e) if e.contains("No such file") || e.contains("not found") => AwsIdentity {
            arn: None,
            account: None,
            user_id: None,
            status: "cli-missing".into(),
            message: Some(format!("aws cli not on PATH: {}", e)),
        },
        Err(e) => AwsIdentity {
            arn: None,
            account: None,
            user_id: None,
            status: "error".into(),
            message: Some(e),
        },
        Ok((true, stdout, _)) => {
            let mut arn = None;
            let mut account = None;
            let mut user_id = None;
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&stdout) {
                arn = v.get("Arn").and_then(|s| s.as_str()).map(String::from);
                account = v.get("Account").and_then(|s| s.as_str()).map(String::from);
                user_id = v.get("UserId").and_then(|s| s.as_str()).map(String::from);
            }
            AwsIdentity {
                arn,
                account,
                user_id,
                status: "authed".into(),
                message: None,
            }
        }
        Ok((false, _, stderr)) => {
            let s = stderr.to_lowercase();
            let status = if s.contains("token has expired")
                || s.contains("sso session associated with this profile has expired")
                || s.contains("expiredtoken")
            {
                "expired"
            } else if s.contains("could not be found") || s.contains("unable to locate credentials") {
                "no-credentials"
            } else {
                "error"
            };
            AwsIdentity {
                arn: None,
                account: None,
                user_id: None,
                status: status.into(),
                message: Some(stderr.trim().to_string()),
            }
        }
    };

    if let Ok(mut cache) = id_cache().lock() {
        cache.insert(profile, (Instant::now(), id.clone()));
    }
    id
}

#[derive(Serialize, Clone)]
pub struct AwsLoginResult {
    success: bool,
    stdout: String,
    stderr: String,
}

#[tauri::command]
pub async fn aws_sso_login(profile: String) -> AwsLoginResult {
    let r = run_aws_cli(&["sso", "login"], Some(&profile));
    // Drop the cached "expired" identity so the next aws_caller_identity
    // call doesn't lie about state.
    if let Ok(mut cache) = id_cache().lock() {
        cache.remove(&profile);
    }
    match r {
        Ok((ok, out, err)) => AwsLoginResult {
            success: ok,
            stdout: out,
            stderr: err,
        },
        Err(e) => AwsLoginResult {
            success: false,
            stdout: String::new(),
            stderr: e,
        },
    }
}

// ============================================================
// JSON CLI helper — every submodule shells `aws ... --output json`
// ============================================================

fn aws_json<T: serde::de::DeserializeOwned>(
    profile: &str,
    args: &[&str],
) -> Result<T, String> {
    let (ok, stdout, stderr) = run_aws_cli(args, Some(profile))
        .map_err(|e| format!("spawn failed: {e}"))?;
    if !ok {
        return Err(stderr.trim().to_string());
    }
    serde_json::from_str::<T>(&stdout).map_err(|e| format!("json decode failed: {e}"))
}

// ============================================================
// ECS
// ============================================================

#[derive(Serialize, Clone)]
pub struct EcsCluster {
    name: String,
    arn: String,
    services_count: Option<i64>,
    tasks_running: Option<i64>,
    tasks_pending: Option<i64>,
    status: Option<String>,
}

#[tauri::command]
pub async fn aws_ecs_clusters(profile: String) -> Result<Vec<EcsCluster>, String> {
    #[derive(serde::Deserialize)]
    struct ArnList {
        #[serde(rename = "clusterArns")]
        cluster_arns: Vec<String>,
    }
    let list: ArnList =
        aws_json(&profile, &["ecs", "list-clusters", "--output", "json"])?;
    if list.cluster_arns.is_empty() {
        return Ok(Vec::new());
    }

    #[derive(serde::Deserialize)]
    struct Describe {
        clusters: Vec<DescribeCluster>,
    }
    #[derive(serde::Deserialize)]
    struct DescribeCluster {
        #[serde(rename = "clusterName")]
        cluster_name: String,
        #[serde(rename = "clusterArn")]
        cluster_arn: String,
        status: Option<String>,
        #[serde(rename = "activeServicesCount")]
        active_services_count: Option<i64>,
        #[serde(rename = "runningTasksCount")]
        running_tasks_count: Option<i64>,
        #[serde(rename = "pendingTasksCount")]
        pending_tasks_count: Option<i64>,
    }

    let mut args: Vec<String> = vec![
        "ecs".into(),
        "describe-clusters".into(),
        "--clusters".into(),
    ];
    for arn in &list.cluster_arns {
        args.push(arn.clone());
    }
    args.extend(["--output".into(), "json".into()]);
    let args_ref: Vec<&str> = args.iter().map(String::as_str).collect();
    let described: Describe = aws_json(&profile, &args_ref)?;

    Ok(described
        .clusters
        .into_iter()
        .map(|c| EcsCluster {
            name: c.cluster_name,
            arn: c.cluster_arn,
            services_count: c.active_services_count,
            tasks_running: c.running_tasks_count,
            tasks_pending: c.pending_tasks_count,
            status: c.status,
        })
        .collect())
}

#[derive(Serialize, Clone)]
pub struct EcsService {
    name: String,
    arn: String,
    desired: Option<i64>,
    running: Option<i64>,
    pending: Option<i64>,
    status: Option<String>,
    /// PRIMARY deploy createdAt — useful for "deployed N ago"
    primary_created_at: Option<String>,
    primary_updated_at: Option<String>,
}

#[tauri::command]
pub async fn aws_ecs_services(
    profile: String,
    cluster: String,
) -> Result<Vec<EcsService>, String> {
    #[derive(serde::Deserialize)]
    struct ArnList {
        #[serde(rename = "serviceArns")]
        arns: Vec<String>,
    }
    let list: ArnList = aws_json(
        &profile,
        &[
            "ecs",
            "list-services",
            "--cluster",
            &cluster,
            "--output",
            "json",
        ],
    )?;
    if list.arns.is_empty() {
        return Ok(Vec::new());
    }

    // describe-services accepts at most 10 at a time.
    let mut out = Vec::new();
    for chunk in list.arns.chunks(10) {
        let mut args: Vec<String> = vec![
            "ecs".into(),
            "describe-services".into(),
            "--cluster".into(),
            cluster.clone(),
            "--services".into(),
        ];
        for a in chunk {
            args.push(a.clone());
        }
        args.extend(["--output".into(), "json".into()]);
        let args_ref: Vec<&str> = args.iter().map(String::as_str).collect();

        #[derive(serde::Deserialize)]
        struct Resp {
            services: Vec<Svc>,
        }
        #[derive(serde::Deserialize)]
        struct Svc {
            #[serde(rename = "serviceName")]
            service_name: String,
            #[serde(rename = "serviceArn")]
            service_arn: String,
            #[serde(rename = "desiredCount")]
            desired_count: Option<i64>,
            #[serde(rename = "runningCount")]
            running_count: Option<i64>,
            #[serde(rename = "pendingCount")]
            pending_count: Option<i64>,
            status: Option<String>,
            deployments: Option<Vec<Deploy>>,
        }
        #[derive(serde::Deserialize)]
        struct Deploy {
            status: Option<String>,
            #[serde(rename = "createdAt")]
            created_at: Option<String>,
            #[serde(rename = "updatedAt")]
            updated_at: Option<String>,
        }

        let resp: Resp = aws_json(&profile, &args_ref)?;
        for s in resp.services {
            let primary = s
                .deployments
                .as_ref()
                .and_then(|d| d.iter().find(|x| x.status.as_deref() == Some("PRIMARY")));
            out.push(EcsService {
                primary_created_at: primary.and_then(|p| p.created_at.clone()),
                primary_updated_at: primary.and_then(|p| p.updated_at.clone()),
                name: s.service_name,
                arn: s.service_arn,
                desired: s.desired_count,
                running: s.running_count,
                pending: s.pending_count,
                status: s.status,
            });
        }
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

#[derive(Serialize, Clone)]
pub struct EcsTask {
    arn: String,
    task_id: String,
    status: Option<String>,
    desired_status: Option<String>,
    health_status: Option<String>,
    cpu: Option<String>,
    memory: Option<String>,
    started_at: Option<String>,
    last_status_change: Option<String>,
}

#[tauri::command]
pub async fn aws_ecs_tasks(
    profile: String,
    cluster: String,
    service: String,
) -> Result<Vec<EcsTask>, String> {
    #[derive(serde::Deserialize)]
    struct ArnList {
        #[serde(rename = "taskArns")]
        arns: Vec<String>,
    }
    let list: ArnList = aws_json(
        &profile,
        &[
            "ecs",
            "list-tasks",
            "--cluster",
            &cluster,
            "--service-name",
            &service,
            "--output",
            "json",
        ],
    )?;
    if list.arns.is_empty() {
        return Ok(Vec::new());
    }

    let mut args: Vec<String> = vec![
        "ecs".into(),
        "describe-tasks".into(),
        "--cluster".into(),
        cluster.clone(),
        "--tasks".into(),
    ];
    for a in &list.arns {
        args.push(a.clone());
    }
    args.extend(["--output".into(), "json".into()]);
    let args_ref: Vec<&str> = args.iter().map(String::as_str).collect();

    #[derive(serde::Deserialize)]
    struct Resp {
        tasks: Vec<Task>,
    }
    #[derive(serde::Deserialize)]
    struct Task {
        #[serde(rename = "taskArn")]
        task_arn: String,
        #[serde(rename = "lastStatus")]
        last_status: Option<String>,
        #[serde(rename = "desiredStatus")]
        desired_status: Option<String>,
        #[serde(rename = "healthStatus")]
        health_status: Option<String>,
        cpu: Option<String>,
        memory: Option<String>,
        #[serde(rename = "startedAt")]
        started_at: Option<String>,
        #[serde(rename = "executionStoppedAt")]
        execution_stopped_at: Option<String>,
    }
    let resp: Resp = aws_json(&profile, &args_ref)?;
    Ok(resp
        .tasks
        .into_iter()
        .map(|t| EcsTask {
            task_id: t
                .task_arn
                .rsplit('/')
                .next()
                .unwrap_or(&t.task_arn)
                .to_string(),
            arn: t.task_arn,
            status: t.last_status,
            desired_status: t.desired_status,
            health_status: t.health_status,
            cpu: t.cpu,
            memory: t.memory,
            started_at: t.started_at,
            last_status_change: t.execution_stopped_at,
        })
        .collect())
}

// ============================================================
// stubs for EC2/Lambda/SQS/CloudWatch/Billing/S3
//
// All implemented as live CLI calls so the views work day-one — but kept
// shallow (single list, no detail) so the iteration scope stays manageable.
// Drill-down for these comes after the ECS path is dialed in.
// ============================================================

#[derive(Serialize, Clone)]
pub struct Ec2Instance {
    instance_id: String,
    name: Option<String>,
    state: Option<String>,
    instance_type: Option<String>,
    private_ip: Option<String>,
    public_ip: Option<String>,
    launch_time: Option<String>,
}

#[tauri::command]
pub async fn aws_ec2_instances(profile: String) -> Result<Vec<Ec2Instance>, String> {
    #[derive(serde::Deserialize)]
    struct Resp {
        #[serde(rename = "Reservations")]
        reservations: Vec<Reservation>,
    }
    #[derive(serde::Deserialize)]
    struct Reservation {
        #[serde(rename = "Instances")]
        instances: Vec<Inst>,
    }
    #[derive(serde::Deserialize)]
    struct Inst {
        #[serde(rename = "InstanceId")]
        instance_id: String,
        #[serde(rename = "InstanceType")]
        instance_type: Option<String>,
        #[serde(rename = "State")]
        state: Option<InstState>,
        #[serde(rename = "PrivateIpAddress")]
        private_ip: Option<String>,
        #[serde(rename = "PublicIpAddress")]
        public_ip: Option<String>,
        #[serde(rename = "LaunchTime")]
        launch_time: Option<String>,
        #[serde(rename = "Tags")]
        tags: Option<Vec<Tag>>,
    }
    #[derive(serde::Deserialize)]
    struct InstState {
        #[serde(rename = "Name")]
        name: Option<String>,
    }
    #[derive(serde::Deserialize)]
    struct Tag {
        #[serde(rename = "Key")]
        key: String,
        #[serde(rename = "Value")]
        value: String,
    }

    let resp: Resp = aws_json(
        &profile,
        &["ec2", "describe-instances", "--output", "json"],
    )?;
    let mut out = Vec::new();
    for r in resp.reservations {
        for i in r.instances {
            let name = i
                .tags
                .as_ref()
                .and_then(|tags| tags.iter().find(|t| t.key == "Name"))
                .map(|t| t.value.clone());
            out.push(Ec2Instance {
                name,
                state: i.state.and_then(|s| s.name),
                instance_type: i.instance_type,
                private_ip: i.private_ip,
                public_ip: i.public_ip,
                launch_time: i.launch_time,
                instance_id: i.instance_id,
            });
        }
    }
    out.sort_by(|a, b| {
        let na = a.name.as_deref().unwrap_or("").to_lowercase();
        let nb = b.name.as_deref().unwrap_or("").to_lowercase();
        na.cmp(&nb).then(a.instance_id.cmp(&b.instance_id))
    });
    Ok(out)
}

#[derive(Serialize, Clone)]
pub struct LambdaFn {
    name: String,
    runtime: Option<String>,
    last_modified: Option<String>,
    memory_size: Option<i64>,
    timeout: Option<i64>,
    handler: Option<String>,
}

#[tauri::command]
pub async fn aws_lambda_functions(profile: String) -> Result<Vec<LambdaFn>, String> {
    #[derive(serde::Deserialize)]
    struct Resp {
        #[serde(rename = "Functions")]
        functions: Vec<Fn0>,
    }
    #[derive(serde::Deserialize)]
    struct Fn0 {
        #[serde(rename = "FunctionName")]
        name: String,
        #[serde(rename = "Runtime")]
        runtime: Option<String>,
        #[serde(rename = "LastModified")]
        last_modified: Option<String>,
        #[serde(rename = "MemorySize")]
        memory_size: Option<i64>,
        #[serde(rename = "Timeout")]
        timeout: Option<i64>,
        #[serde(rename = "Handler")]
        handler: Option<String>,
    }
    let resp: Resp = aws_json(
        &profile,
        &["lambda", "list-functions", "--output", "json"],
    )?;
    let mut out: Vec<LambdaFn> = resp
        .functions
        .into_iter()
        .map(|f| LambdaFn {
            name: f.name,
            runtime: f.runtime,
            last_modified: f.last_modified,
            memory_size: f.memory_size,
            timeout: f.timeout,
            handler: f.handler,
        })
        .collect();
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

#[derive(Serialize, Clone)]
pub struct SqsQueue {
    name: String,
    url: String,
    messages: Option<String>,
    in_flight: Option<String>,
    delayed: Option<String>,
}

#[tauri::command]
pub async fn aws_sqs_queues(profile: String) -> Result<Vec<SqsQueue>, String> {
    #[derive(serde::Deserialize)]
    struct Resp {
        #[serde(default, rename = "QueueUrls")]
        urls: Vec<String>,
    }
    let resp: Resp = aws_json(
        &profile,
        &["sqs", "list-queues", "--output", "json"],
    )
    .unwrap_or(Resp { urls: vec![] });

    let mut out = Vec::new();
    for url in resp.urls {
        let name = url.rsplit('/').next().unwrap_or(&url).to_string();
        // Skip attribute fetch — too many round-trips for a list view.
        // Detail panel will pull get-queue-attributes per queue lazily.
        out.push(SqsQueue {
            name,
            url,
            messages: None,
            in_flight: None,
            delayed: None,
        });
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

#[derive(Serialize, Clone)]
pub struct BillingMonth {
    period_start: String,
    period_end: String,
    total: String,
    unit: String,
    is_current: bool,
    by_service: Vec<BillingService>,
}

#[derive(Serialize, Clone)]
pub struct BillingService {
    service: String,
    amount: String,
    unit: String,
}

/// Pull N months of billing data. The current month is partial (start-of-
/// month → today); previous months span the whole month. Total per month
/// is computed by SUMMING the groups, because Cost Explorer's top-level
/// `Total` block returns empty when `--group-by` is in play (only `Groups`
/// is populated). That bug was the source of the $0.00 readout.
#[tauri::command]
pub async fn aws_billing_months(
    profile: String,
    months_back: u32,
) -> Result<Vec<BillingMonth>, String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs();
    let (cy, cm, cd) = ymd_utc(now);

    // Earliest date we want: first-of-month, `months_back` months before
    // the current month.
    let mut start_y = cy;
    let mut start_m = cm as i32 - months_back as i32;
    while start_m < 1 {
        start_m += 12;
        start_y -= 1;
    }
    // CE's End is exclusive — pass tomorrow so today's partial usage is
    // included.
    let start = format!("{:04}-{:02}-01", start_y, start_m);
    let end = format!("{:04}-{:02}-{:02}", cy, cm, cd.min(28) + 1).min({
        // Cap end at first-of-next-month to keep CE happy.
        let (ny, nm) = if cm == 12 { (cy + 1, 1) } else { (cy, cm + 1) };
        format!("{:04}-{:02}-01", ny, nm)
    });

    // Two group-by dimensions: RECORD_TYPE + SERVICE. CE applies credits
    // *into* each service's row when you group by SERVICE alone, hiding
    // the real Usage charge (e.g. Claude Haiku showed as $0 because its
    // gross usage exactly cancelled with its applied credit). Grouping
    // by RECORD_TYPE first keeps Usage / Credit / Tax as distinct rows
    // — Usage now matches the Console "Cost and usage" widget exactly.
    let resp_v: serde_json::Value = aws_json(
        &profile,
        &[
            "ce",
            "get-cost-and-usage",
            "--time-period",
            &format!("Start={start},End={end}"),
            "--granularity",
            "MONTHLY",
            "--metrics",
            "UnblendedCost",
            // --group-by takes a *list* of dimensions space-separated
            // under one flag; repeating "--group-by" makes the CLI keep
            // only the last value (which is why service names rendered
            // as "?" — the SERVICE key landed at position 0 with nothing
            // at position 1).
            "--group-by",
            "Type=DIMENSION,Key=RECORD_TYPE",
            "Type=DIMENSION,Key=SERVICE",
            "--output",
            "json",
        ],
    )?;

    let results = resp_v
        .get("ResultsByTime")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let current_period_start = format!("{:04}-{:02}-01", cy, cm);

    let mut months: Vec<BillingMonth> = Vec::new();
    for r in results {
        let period_start = r
            .get("TimePeriod")
            .and_then(|t| t.get("Start"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let period_end = r
            .get("TimePeriod")
            .and_then(|t| t.get("End"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let mut by_service: Vec<BillingService> = Vec::new();
        let mut unit = "USD".to_string();
        let mut gross_total_f = 0.0_f64;
        if let Some(groups) = r.get("Groups").and_then(|v| v.as_array()) {
            for g in groups {
                let keys = g.get("Keys").and_then(|k| k.as_array());
                let record_type = keys
                    .and_then(|a| a.first())
                    .and_then(|v| v.as_str())
                    .unwrap_or("?");
                let service = keys
                    .and_then(|a| a.get(1))
                    .and_then(|v| v.as_str())
                    .unwrap_or("?")
                    .to_string();
                // Tax rows are essentially $0 for this org; drop them
                // to keep the breakdown tight. Refund/Credit rows stay
                // (they show up as negatives in the credits section).
                if record_type == "Tax" {
                    continue;
                }
                let amount = g
                    .get("Metrics")
                    .and_then(|m| m.get("UnblendedCost"))
                    .and_then(|m| m.get("Amount"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("0")
                    .to_string();
                let unit2 = g
                    .get("Metrics")
                    .and_then(|m| m.get("UnblendedCost"))
                    .and_then(|m| m.get("Unit"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("USD")
                    .to_string();
                if unit == "USD" {
                    unit = unit2.clone();
                }
                if record_type == "Usage" {
                    gross_total_f += amount.parse::<f64>().unwrap_or(0.0);
                }
                by_service.push(BillingService {
                    service,
                    amount,
                    unit: unit2,
                });
            }
            by_service.sort_by(|a, b| {
                let aa: f64 = a.amount.parse().unwrap_or(0.0);
                let bb: f64 = b.amount.parse().unwrap_or(0.0);
                bb.partial_cmp(&aa).unwrap_or(std::cmp::Ordering::Equal)
            });
        }

        // The hero number shown in the UI is gross Usage (matches the
        // Console "Cost and usage" widget). Credits & refunds are still
        // present in `by_service` as negative rows so the frontend can
        // render them in a separate section and compute a net.
        let total = format!("{:.2}", gross_total_f);
        let is_current = period_start == current_period_start;

        months.push(BillingMonth {
            period_start,
            period_end,
            total,
            unit,
            is_current,
            by_service,
        });
    }

    Ok(months)
}

// Cheap UTC YMD from unix seconds — avoids pulling chrono just for this.
fn ymd_utc(secs: u64) -> (i32, u32, u32) {
    let days = (secs / 86400) as i64;
    // 1970-01-01 was Thursday. Use Howard Hinnant's date algorithm.
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as i64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = if m <= 2 { y + 1 } else { y };
    (y as i32, m, d)
}

#[derive(Serialize, Clone)]
pub struct S3Bucket {
    name: String,
    created_at: Option<String>,
}

#[tauri::command]
pub async fn aws_s3_buckets(profile: String) -> Result<Vec<S3Bucket>, String> {
    #[derive(serde::Deserialize)]
    struct Resp {
        #[serde(rename = "Buckets")]
        buckets: Vec<B>,
    }
    #[derive(serde::Deserialize)]
    struct B {
        #[serde(rename = "Name")]
        name: String,
        #[serde(rename = "CreationDate")]
        created: Option<String>,
    }
    let resp: Resp = aws_json(
        &profile,
        &["s3api", "list-buckets", "--output", "json"],
    )?;
    let mut out: Vec<S3Bucket> = resp
        .buckets
        .into_iter()
        .map(|b| S3Bucket {
            name: b.name,
            created_at: b.created,
        })
        .collect();
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

// ============================================================
// ECS task → CloudWatch log stream resolution
// ============================================================
//
// Each ECS task is a task definition + a task ID. The task definition
// pins log configuration per container — for `awslogs` driver that means
// (logGroup, region, streamPrefix). The actual log stream for a specific
// task is then `<streamPrefix>/<containerName>/<taskId>`.
//
// We surface this from a single command so the UI can hop straight from
// "user clicked a task row" → "tail its logs" without juggling describe
// calls in JS.

#[derive(Serialize, Clone)]
pub struct EcsTaskLog {
    /// CloudWatch log group from the task def's logConfiguration.
    log_group: String,
    /// `<prefix>/<container>/<task-id>` — the specific stream for this task.
    log_stream: String,
    container_name: String,
    region: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct EcsServiceLog {
    /// CloudWatch log group from the service's task definition.
    /// No stream — caller tails the whole group (all tasks mixed).
    log_group: String,
    container_name: String,
    region: Option<String>,
}

#[tauri::command]
pub async fn aws_ecs_service_log_config(
    profile: String,
    cluster: String,
    service: String,
) -> Result<EcsServiceLog, String> {
    // 1. Service → task definition ARN. Doesn't require a running task; we
    //    pull straight from the service's spec.
    let svc_v: serde_json::Value = aws_json(
        &profile,
        &[
            "ecs",
            "describe-services",
            "--cluster",
            &cluster,
            "--services",
            &service,
            "--output",
            "json",
        ],
    )?;
    let td_arn = svc_v
        .get("services")
        .and_then(|s| s.as_array())
        .and_then(|a| a.first())
        .and_then(|s| s.get("taskDefinition"))
        .and_then(|v| v.as_str())
        .ok_or("service has no taskDefinition")?
        .to_string();

    // 2. Task definition → log group from first awslogs container.
    let td_v: serde_json::Value = aws_json(
        &profile,
        &[
            "ecs",
            "describe-task-definition",
            "--task-definition",
            &td_arn,
            "--output",
            "json",
        ],
    )?;
    let containers = td_v
        .get("taskDefinition")
        .and_then(|t| t.get("containerDefinitions"))
        .and_then(|c| c.as_array())
        .ok_or("no containerDefinitions")?;

    containers
        .iter()
        .find_map(|c| {
            let lc = c.get("logConfiguration")?;
            if lc.get("logDriver").and_then(|d| d.as_str()) != Some("awslogs") {
                return None;
            }
            let opts = lc.get("options")?;
            let group = opts.get("awslogs-group").and_then(|v| v.as_str())?.to_string();
            let region = opts.get("awslogs-region").and_then(|v| v.as_str()).map(String::from);
            let name = c
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            Some(EcsServiceLog {
                log_group: group,
                container_name: name,
                region,
            })
        })
        .ok_or_else(|| "no container with awslogs driver".to_string())
}

#[tauri::command]
pub async fn aws_ecs_task_log_config(
    profile: String,
    cluster: String,
    task_arn: String,
) -> Result<EcsTaskLog, String> {
    // 1. describe-tasks → taskDefinitionArn + container names
    let task_v: serde_json::Value = aws_json(
        &profile,
        &[
            "ecs",
            "describe-tasks",
            "--cluster",
            &cluster,
            "--tasks",
            &task_arn,
            "--output",
            "json",
        ],
    )?;

    let task = task_v
        .get("tasks")
        .and_then(|t| t.as_array())
        .and_then(|a| a.first())
        .ok_or("task not found")?;
    let td_arn = task
        .get("taskDefinitionArn")
        .and_then(|v| v.as_str())
        .ok_or("no taskDefinitionArn")?;
    let task_id = task_arn.rsplit('/').next().unwrap_or(&task_arn).to_string();

    // 2. describe-task-definition → logConfiguration for the first container
    //    that uses awslogs driver. (Most ECS services have a single primary
    //    container; sidecars usually share or have no logs.)
    let td_v: serde_json::Value = aws_json(
        &profile,
        &[
            "ecs",
            "describe-task-definition",
            "--task-definition",
            td_arn,
            "--output",
            "json",
        ],
    )?;
    let containers = td_v
        .get("taskDefinition")
        .and_then(|t| t.get("containerDefinitions"))
        .and_then(|c| c.as_array())
        .ok_or("no containerDefinitions")?;

    let chosen = containers.iter().find_map(|c| {
        let lc = c.get("logConfiguration")?;
        if lc.get("logDriver").and_then(|d| d.as_str()) != Some("awslogs") {
            return None;
        }
        let opts = lc.get("options")?;
        let group = opts.get("awslogs-group").and_then(|v| v.as_str())?.to_string();
        let prefix = opts
            .get("awslogs-stream-prefix")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let region = opts.get("awslogs-region").and_then(|v| v.as_str()).map(String::from);
        let name = c.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
        // ECS stream naming: `<prefix>/<container>/<task-id>`. If prefix is
        // missing the stream is just `<container>/<task-id>`.
        let stream = if prefix.is_empty() {
            format!("{}/{}", name, task_id)
        } else {
            format!("{}/{}/{}", prefix, name, task_id)
        };
        Some(EcsTaskLog {
            log_group: group,
            log_stream: stream,
            container_name: name,
            region,
        })
    });

    chosen.ok_or_else(|| "no container with awslogs driver".to_string())
}

// ============================================================
// CloudWatch logs live tail (shell-out to `aws logs tail --follow`)
// ============================================================
//
// `aws logs tail <group> --follow` streams new events to stdout indefin-
// itely. We spawn it, capture stdout line-by-line on a thread, and ship
// each line through a Tauri Channel — same pattern as PTY output.
//
// Each tail is tracked by an integer id so the frontend can stop it
// explicitly when the user navigates away.

use dashmap::DashMap;
use std::io::{BufRead, BufReader};
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use tauri::ipc::Channel;

#[derive(Default)]
pub struct LogsTailManager {
    pub(crate) tails: DashMap<u32, Child>,
}

static NEXT_TAIL_ID: AtomicU32 = AtomicU32::new(1);

#[tauri::command]
pub async fn aws_logs_tail_start(
    manager: tauri::State<'_, LogsTailManager>,
    profile: String,
    log_group: String,
    log_stream: Option<String>,
    since: Option<String>,
    on_line: Channel<String>,
) -> Result<u32, String> {
    let bin = std::env::var("AWS_CLI").unwrap_or_else(|_| "aws".to_string());
    let mut cmd = std::process::Command::new(&bin);
    cmd.env("AWS_PROFILE", &profile)
        .env("AWS_PAGER", "")
        .env("NO_COLOR", "1")
        // Critical: the AWS CLI's embedded Python detects pipe-not-TTY and
        // switches stdout to block buffering (~8 KB). Low-volume log
        // streams never fill that buffer, so our reader thread hangs and
        // the UI just shows "waiting for new ones". PYTHONUNBUFFERED=1
        // forces line-buffered flushes so each event appears immediately.
        .env("PYTHONUNBUFFERED", "1")
        .arg("logs")
        .arg("tail")
        .arg(&log_group)
        .arg("--follow")
        .arg("--format")
        .arg("short");
    if let Some(stream) = &log_stream {
        cmd.arg("--log-stream-names").arg(stream);
    }
    cmd.arg("--since").arg(since.as_deref().unwrap_or("5m"));
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take();
    let id = NEXT_TAIL_ID.fetch_add(1, Ordering::Relaxed);
    manager.tails.insert(id, child);

    // Reader thread — emit each line. Empty payload signals end-of-stream
    // so the UI can flip "live" → "ended".
    let line_ch = on_line.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().flatten() {
            if line_ch.send(line).is_err() {
                break;
            }
        }
        let _ = line_ch.send(String::new());
    });
    // stderr drain — surface failures (e.g. "log group does not exist")
    // as a prefixed line on the same channel so the user sees them.
    if let Some(stderr) = stderr {
        let line_ch = on_line.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().flatten() {
                let _ = line_ch.send(format!("[err] {}", line));
            }
        });
    }

    Ok(id)
}

#[tauri::command]
pub fn aws_logs_tail_stop(
    manager: tauri::State<'_, LogsTailManager>,
    id: u32,
) -> Result<(), String> {
    if let Some((_, mut child)) = manager.tails.remove(&id) {
        let _ = child.kill();
    }
    Ok(())
}

// Keep the unused-Arc import lint happy on platforms that don't reach the
// LogsTailManager code path.
#[allow(dead_code)]
fn _arc_keep_alive() -> Arc<()> { Arc::new(()) }

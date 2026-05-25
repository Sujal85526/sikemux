import { invoke } from "@tauri-apps/api/core";
import { emit } from "../state/bus";

// AWS-aware invoke. AWS subprocess errors come back tagged with one of
// these category strings (see src-tauri/src/error.rs); any of them means
// the user's token / creds are no good and the TopBar chip + AWS pane
// need to flip to "needs sign-in" state. We emit a bus event so App.tsx
// can invalidate the cached identity → re-fetch → status flips to
// expired → chip turns red → pane renders the auth modal.
async function awsInvoke<T>(
  cmd: string,
  args: Record<string, unknown>,
): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    const err = e as { category?: string; message?: string };
    const cat = err?.category ?? "";
    if (
      cat === "aws-token-expired" ||
      cat === "aws-no-credentials" ||
      cat === "aws-cli-missing"
    ) {
      // Most aws_* commands take a `profile` arg; grab it so listeners
      // know whose identity cache to drop.
      const profile = (args["profile"] as string) ?? "";
      emit({
        type: "aws-auth-expired",
        profile,
        reason: err?.message ?? cat,
      });
    }
    throw e;
  }
}

export interface AwsProfile {
  name: string;
  region: string | null;
  sso_start_url: string | null;
  sso_region: string | null;
  sso_account_id: string | null;
  sso_role_name: string | null;
  /** "sso" | "credentials" | "role" | "credential_process" */
  kind: string;
}

export type AwsStatus =
  | "authed"
  | "expired"
  | "no-credentials"
  | "error"
  | "cli-missing"
  | "unknown"
  | "checking";

export interface AwsIdentity {
  arn: string | null;
  account: string | null;
  user_id: string | null;
  status: Exclude<AwsStatus, "unknown" | "checking">;
  message: string | null;
}

export interface AwsLoginResult {
  success: boolean;
  stdout: string;
  stderr: string;
}

// ---- ECS -----------------------------------------------------------------

export interface EcsCluster {
  name: string;
  arn: string;
  services_count: number | null;
  tasks_running: number | null;
  tasks_pending: number | null;
  status: string | null;
}

export interface EcsService {
  name: string;
  arn: string;
  desired: number | null;
  running: number | null;
  pending: number | null;
  status: string | null;
  primary_created_at: string | null;
  primary_updated_at: string | null;
}

export interface EcsTask {
  arn: string;
  task_id: string;
  status: string | null;
  desired_status: string | null;
  health_status: string | null;
  cpu: string | null;
  memory: string | null;
  started_at: string | null;
  last_status_change: string | null;
}

// ---- EC2/Lambda/SQS/CW/Billing/S3 ---------------------------------------

export interface Ec2Instance {
  instance_id: string;
  name: string | null;
  state: string | null;
  instance_type: string | null;
  private_ip: string | null;
  public_ip: string | null;
  launch_time: string | null;
}

export interface LambdaFn {
  name: string;
  runtime: string | null;
  last_modified: string | null;
  memory_size: number | null;
  timeout: number | null;
  handler: string | null;
}

export interface SqsQueue {
  name: string;
  url: string;
  messages: string | null;
  in_flight: string | null;
  delayed: string | null;
}

export interface EcsTaskLog {
  log_group: string;
  log_stream: string;
  container_name: string;
  region: string | null;
}

export interface EcsServiceLog {
  log_group: string;
  container_name: string;
  region: string | null;
}

export interface BillingService {
  service: string;
  amount: string;
  unit: string;
}

export interface BillingMonth {
  period_start: string;
  period_end: string;
  total: string;
  unit: string;
  is_current: boolean;
  by_service: BillingService[];
}

export interface S3Bucket {
  name: string;
  created_at: string | null;
}

export const awsApi = {
  // Profile list + identity check don't go through the auth wrapper —
  // they're how we *detect* auth state, looping them into the
  // invalidation event would be self-referential.
  profiles: () => invoke<AwsProfile[]>("aws_profiles"),
  identity: (profile: string, force = false) =>
    invoke<AwsIdentity>("aws_caller_identity", { profile, force }),
  ssoLogin: (profile: string) =>
    invoke<AwsLoginResult>("aws_sso_login", { profile }),
  ecsClusters: (profile: string) =>
    awsInvoke<EcsCluster[]>("aws_ecs_clusters", { profile }),
  ecsServices: (profile: string, cluster: string) =>
    awsInvoke<EcsService[]>("aws_ecs_services", { profile, cluster }),
  ecsTasks: (profile: string, cluster: string, service: string) =>
    awsInvoke<EcsTask[]>("aws_ecs_tasks", { profile, cluster, service }),
  ecsTaskLogConfig: (profile: string, cluster: string, taskArn: string) =>
    awsInvoke<EcsTaskLog>("aws_ecs_task_log_config", {
      profile,
      cluster,
      taskArn,
    }),
  ecsServiceLogConfig: (profile: string, cluster: string, service: string) =>
    awsInvoke<EcsServiceLog>("aws_ecs_service_log_config", {
      profile,
      cluster,
      service,
    }),
  ec2Instances: (profile: string) =>
    awsInvoke<Ec2Instance[]>("aws_ec2_instances", { profile }),
  lambdaFunctions: (profile: string) =>
    awsInvoke<LambdaFn[]>("aws_lambda_functions", { profile }),
  sqsQueues: (profile: string) =>
    awsInvoke<SqsQueue[]>("aws_sqs_queues", { profile }),
  billingMonths: (profile: string, monthsBack = 5) =>
    awsInvoke<BillingMonth[]>("aws_billing_months", {
      profile,
      monthsBack,
    }),
  s3Buckets: (profile: string) =>
    awsInvoke<S3Bucket[]>("aws_s3_buckets", { profile }),
  logsTailStop: (id: number) => invoke<void>("aws_logs_tail_stop", { id }),
};

type Params = Record<string, unknown>;

const minutesAgo = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString();

const SERVICES = [
  ["api-gateway", 6, 6],
  ["billing-service", 4, 4],
  ["checkout-web", 3, 3],
  ["search-service", 4, 3],
  ["ingest-worker", 2, 2],
] as const;

const LOG_LINES = [
  "INFO  request completed method=GET path=/v1/search status=200 latency_ms=38",
  "INFO  request completed method=POST path=/v1/checkout status=200 latency_ms=212",
  "WARN  retrying after 429 upstream=payments attempt=2",
  "INFO  request completed method=GET path=/v1/users/me status=200 latency_ms=6",
  "INFO  cache refreshed key=catalog:featured entries=48",
  "ERROR upstream timed out after 30s upstream=payments path=/v1/checkout",
  "INFO  request completed method=POST path=/v1/checkout status=200 latency_ms=198",
  "INFO  request completed method=GET path=/v1/search status=200 latency_ms=41",
  "INFO  health check ok uptime=6d4h",
  "INFO  request completed method=GET path=/v1/invoices status=200 latency_ms=77",
];

const month = (offset: number, total: number, current = false) => {
  const start = new Date(2026, 8 - offset, 1);
  const end = new Date(2026, 9 - offset, 1);
  const share = [0.46, 0.21, 0.12, 0.09, 0.07, 0.05];
  const names = [
    "Amazon Elastic Container Service",
    "Amazon Relational Database Service",
    "Amazon Elastic Compute Cloud",
    "Amazon Simple Storage Service",
    "AWS Lambda",
    "Amazon CloudWatch",
  ];
  return {
    period_start: start.toISOString().slice(0, 10),
    period_end: end.toISOString().slice(0, 10),
    total: total.toFixed(2),
    unit: "USD",
    is_current: current,
    by_service: names.map((service, index) => ({
      service,
      amount: (total * share[index]).toFixed(2),
      unit: "USD",
    })),
  };
};

export const AWS: Record<string, (params: Params) => unknown> = {
  profiles: () => [
    {
      name: "acme-prod",
      region: "eu-west-1",
      sso_start_url: "https://acme.awsapps.com/start",
      sso_region: "eu-west-1",
      sso_account_id: "123456789012",
      sso_role_name: "Developer",
      kind: "sso",
    },
  ],
  identity: () => ({
    arn: "arn:aws:sts::123456789012:assumed-role/Developer/edon",
    account: "123456789012",
    user_id: "AROAEXAMPLE:edon",
    status: "authed",
    message: null,
  }),
  ecsClusters: () => [
    {
      name: "prod",
      arn: "arn:aws:ecs:eu-west-1:123456789012:cluster/prod",
      services_count: 5,
      tasks_running: 18,
      tasks_pending: 1,
      status: "ACTIVE",
    },
    {
      name: "staging",
      arn: "arn:aws:ecs:eu-west-1:123456789012:cluster/staging",
      services_count: 5,
      tasks_running: 7,
      tasks_pending: 0,
      status: "ACTIVE",
    },
  ],
  ecsServices: () =>
    SERVICES.map(([name, desired, running], index) => ({
      name,
      arn: `arn:aws:ecs:eu-west-1:123456789012:service/prod/${name}`,
      desired,
      running,
      pending: desired - running,
      status: "ACTIVE",
      primary_created_at: minutesAgo(600 + index * 90),
      primary_updated_at: minutesAgo(40 + index * 55),
    })),
  ecsTasks: () =>
    Array.from({ length: 6 }, (_, index) => {
      const id = `9f${index}c4e1a7b2d44e08a1${index}3f6e2c9d0b${index}`;
      return {
        arn: `arn:aws:ecs:eu-west-1:123456789012:task/prod/${id}`,
        task_id: id,
        status: "RUNNING",
        desired_status: "RUNNING",
        health_status: "HEALTHY",
        cpu: "512",
        memory: "1024",
        started_at: minutesAgo(90 + index * 7),
        last_status_change: minutesAgo(88 + index * 7),
      };
    }),
  ecsServiceLogConfig: ({ service }) => ({
    log_group: `/ecs/prod/${String(service)}`,
    container_name: String(service),
    region: "eu-west-1",
  }),
  ecsTaskLogConfig: () => ({
    log_group: "/ecs/prod/api-gateway",
    log_stream: "api-gateway/api-gateway/9f0c4e1a",
    container_name: "api-gateway",
    region: "eu-west-1",
  }),
  billingMonths: () => [
    month(0, 1843.2, true),
    month(1, 2210.75),
    month(2, 2064.1),
    month(3, 1988.4),
    month(4, 1712.9),
  ],
  ec2Instances: () => [],
  lambdaFunctions: () => [],
  sqsQueues: () => [],
  s3Buckets: () => [],
};

export function awsLogLines(): string[] {
  return LOG_LINES.map(
    (line, index) =>
      `${new Date(Date.now() - (LOG_LINES.length - index) * 4_000).toISOString()} ${line}`,
  );
}

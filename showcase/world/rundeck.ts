type Params = Record<string, unknown>;

const PROJECT = "platform";
const SERVICES = [
  "api-gateway",
  "auth-service",
  "billing-service",
  "checkout-web",
  "search-service",
  "notification-service",
  "ingest-worker",
];
const ENVS = ["staging", "production"];
const BRANCHES = [
  "main",
  "main",
  "release/2.14",
  "main",
  "feat/search-rerank",
  "main",
  "main",
];
const USERS = [
  "edon",
  "maya",
  "deploy-bot",
  "edon",
  "sam",
  "maya",
  "deploy-bot",
];

const iso = (minutesAgo: number) =>
  new Date(Date.now() - minutesAgo * 60_000).toISOString();

const jobId = (service: string, env: string) => `job-${env}-${service}`;

const jobs = ENVS.flatMap((env) =>
  SERVICES.map((service) => ({
    id: jobId(service, env),
    name: service,
    group: `deploy/${env}`,
    project: PROJECT,
    description: `Build and roll out ${service} to ${env}`,
    href: null,
    permalink: null,
    enabled: true,
    scheduled: false,
    scheduleEnabled: true,
  })),
);

let executionId = 48_210;
const summary = (
  index: number,
  env: string,
  minutesAgo: number,
  status = "succeeded",
) => ({
  execution_id: executionId++,
  status,
  custom_status: null,
  user: USERS[index],
  started_at: iso(minutesAgo),
  ended_at: status === "running" ? null : iso(minutesAgo - 4),
  permalink: null,
  branch: BRANCHES[index],
  options: { BRANCH: BRANCHES[index], ENV: env },
});

const cells = ENVS.flatMap((env, envIndex) =>
  SERVICES.map((service, index) => {
    const running = env === "production" && service === "billing-service";
    const failed = env === "staging" && service === "search-service";
    const latest = summary(
      index,
      env,
      12 + index * 37 + envIndex * 90,
      running ? "running" : failed ? "failed" : "succeeded",
    );
    return {
      service,
      name: service,
      job_id: jobId(service, env),
      group: `deploy/${env}`,
      enabled: true,
      scheduled: false,
      latest,
      deployed: failed ? summary(index, env, 600) : latest,
      error: null,
    };
  }),
);

const productionCells = cells.filter(
  (cell) => cell.group === "deploy/production",
);

const LIVE_EXECUTION = 48_199;
const steps = [
  "Checkout",
  "Build image",
  "Push to registry",
  "Migrate database",
  "Roll out",
  "Smoke test",
];

const LOG = [
  [
    "INFO",
    1,
    "Cloning git@github.com:acme/billing-service.git at release/2.14",
  ],
  [
    "INFO",
    1,
    "HEAD is now at 9c41e2a fix(invoices): round VAT per line, not per total",
  ],
  ["INFO", 2, "docker build -t registry.acme.dev/billing-service:9c41e2a ."],
  ["INFO", 2, "#12 [build 6/9] RUN pnpm install --frozen-lockfile"],
  ["INFO", 2, "#12 DONE 18.4s"],
  ["INFO", 2, "#15 exporting to image  \u001b[32mDONE\u001b[0m 3.1s"],
  [
    "INFO",
    3,
    "pushing registry.acme.dev/billing-service:9c41e2a  \u001b[32m✓\u001b[0m 212 MB in 9.8s",
  ],
  ["INFO", 4, "Running migrations: 20260926_add_invoice_line_vat"],
  ["INFO", 4, "\u001b[32m✓\u001b[0m 1 migration applied in 1.2s"],
  ["INFO", 5, "kubectl rollout status deploy/billing-service -n production"],
  [
    "INFO",
    5,
    'Waiting for deployment "billing-service" rollout to finish: 2 of 6 updated replicas are available...',
  ],
  [
    "INFO",
    5,
    'Waiting for deployment "billing-service" rollout to finish: 4 of 6 updated replicas are available...',
  ],
] as const;

const execution = {
  id: LIVE_EXECUTION,
  status: "running",
  customStatus: null,
  user: "edon",
  project: PROJECT,
  "date-started": { date: iso(3), unixtime: Date.now() - 180_000 },
  "date-ended": null,
  permalink: null,
  job: {
    id: jobId("billing-service", "production"),
    name: "billing-service",
    group: "deploy/production",
    project: PROJECT,
    options: { BRANCH: "release/2.14", ENV: "production" },
  },
  argstring: "-BRANCH release/2.14 -ENV production",
};

const workflow = {
  executionState: "RUNNING",
  stepCount: steps.length,
  completed: false,
  steps: steps.map((_step, index) => ({
    id: String(index + 1),
    stepctx: String(index + 1),
    executionState:
      index < 4 ? "SUCCEEDED" : index === 4 ? "RUNNING" : "WAITING",
    startTime: index <= 4 ? iso(3 - index * 0.5) : null,
    endTime: index < 4 ? iso(2.8 - index * 0.5) : null,
    nodeStep: true,
  })),
};

export const RUNDECK_EXECUTION = {
  executionId: LIVE_EXECUTION,
  job: jobs.find((job) => job.id === jobId("billing-service", "production"))!,
};

export const RUNDECK: Record<string, (params: Params) => unknown> = {
  status: () => ({
    configured: true,
    url: "https://rundeck.acme.dev",
    user: "edon",
    token_present: true,
    rundeck_version: "5.8.0",
    ok: true,
    auth_failed: false,
    message: null,
    allow_insecure_private_http: false,
  }),
  projects: () => [
    { name: PROJECT, description: "Customer-facing services" },
    { name: "data", description: "Pipelines and warehouse jobs" },
  ],
  jobIndex: () => [
    { project: PROJECT, jobs, error: null },
    { project: "data", jobs: [], error: null },
  ],
  jobs: () => jobs,
  branchesMatrix: () => ({
    project: PROJECT,
    cells: productionCells,
    error: null,
    partial: false,
    elapsed_ms: 412,
  }),
  jobCells: () => productionCells,
  jobDetail: ({ jobId: id }) => {
    const job = jobs.find((candidate) => candidate.id === id) ?? jobs[0];
    return {
      ...job,
      execution_enabled: true,
      schedule_enabled: true,
      scheduled: false,
      node_filter: null,
      options: [
        {
          name: "BRANCH",
          label: "Branch",
          description: null,
          required: true,
          secure: false,
          value_exposed: false,
          default: "main",
          values: null,
          values_url: null,
          enforced: false,
          multivalued: false,
          delimiter: null,
          is_date: false,
          date_format: null,
          kind: "text",
        },
      ],
      steps,
    };
  },
  executions: () => cells.slice(0, 6).map((cell) => cell.latest),
};

export function rundeckStream(
  method: string,
  emit: (value: unknown) => void,
): void {
  if (method === "watch")
    emit({ execution, state: workflow, error: null, terminal: false });
  if (method === "logs") {
    emit({
      entries: LOG.map(([level, step, log], index) => ({
        time: new Date(Date.now() - (LOG.length - index) * 9_000)
          .toISOString()
          .slice(11, 19),
        level,
        log,
        user: "edon",
        stepctx: String(step),
        node: "rundeck-runner-2",
      })),
      offset: String(LOG.length),
      completed: false,
      failed: false,
      error: null,
    });
  }
}

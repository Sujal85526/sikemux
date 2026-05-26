// Tiny helpers that classify a Rundeck project + job by where it sits in
// the legacy-vs-product dual layout, so the rest of the app (UI, state,
// deploy gating) doesn't need to know the rules.
//
// Two coexisting shapes on the cicd box:
//   * legacy projects (env-as-project): `dev`, `staging`, `Preprod`,
//     `production` — jobs live at `backend/<svc>`. The project IS the env.
//   * product projects: `contractiq`, `marketingiq`, `channeliq` — jobs
//     live at `<env>/backend/<svc>`. The env is the FIRST segment of the
//     job's group path, not the project.
//
// The legacy set is fixed in code (matches Rundeck on-host). Anything not
// in it is treated as product-style and grouped by group-path prefix.

const LEGACY_PROJECTS: ReadonlySet<string> = new Set([
  "dev",
  "staging",
  "preprod",
  "production",
]);

export function isLegacyProject(project: string): boolean {
  return LEGACY_PROJECTS.has(project.toLowerCase());
}

/** Env label used for display + prod-gating. For legacy projects the
 *  project name is the env. For product projects the env is the first
 *  segment of the job's group (e.g. `dev/backend/foo` → "dev"). Falls
 *  back to the project name when the group is missing/flat. */
export function inferEnv(project: string, group: string | null): string {
  if (isLegacyProject(project)) return project.toLowerCase();
  const seg = (group ?? "").split("/")[0] ?? "";
  return seg ? seg.toLowerCase() : project.toLowerCase();
}

/** First segment of a slash-separated group, or null when flat. */
export function envFolderOf(group: string | null): string | null {
  if (!group || !group.includes("/")) return null;
  const head = group.split("/")[0];
  return head || null;
}

/** Legacy default project that historically corresponded to a session.env
 *  label. Used by the project-session deploy chip / openRundeckServiceFor
 *  fall-back when there's no per-product mapping configured. */
export function legacyProjectForEnv(env: string): string | null {
  switch (env.toLowerCase()) {
    case "dev":
      return "dev";
    case "staging":
      return "staging";
    case "preprod":
      return "Preprod";
    case "prod":
    case "production":
      return "production";
    default:
      return null;
  }
}

// Structural classifiers for Rundeck jobs. No hardcoded project lists —
// the layout is derived from each job's `group` path as Rundeck reports
// it. Projects whose jobs all live at the root (`backend/<svc>`) render
// as a flat list; projects whose jobs are nested (`<env>/backend/<svc>`)
// render with env-folder children. The rule is: look at the group, not
// the project name.

/** First segment of a slash-separated group, or null when flat
 *  (e.g. `dev/backend/foo` → `"dev"`; `backend/foo` → `null`). */
export function envFolderOf(group: string | null): string | null {
  if (!group || !group.includes("/")) return null;
  const head = group.split("/")[0];
  return head || null;
}

/** Env label used for display + prod-gating. If the job's group has a
 *  slash, the first segment is the env. Otherwise the project name IS
 *  the env (env-as-project layouts). Purely structural — no name table. */
export function inferEnv(project: string, group: string | null): string {
  return (envFolderOf(group) ?? project).toLowerCase();
}

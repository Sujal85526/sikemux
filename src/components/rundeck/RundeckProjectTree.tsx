import { useMemo } from "react";
import * as cmd from "../../state/commands";
import { useResource } from "../../state/resources";
import { rndJobsR, rndProjectsR } from "../../state/resources.defs";
import { envFolderOf } from "../../state/rundeckShape";
import { useStore } from "../../state/store";
import { IconChevron, IconFolder } from "../Icons";

/** Tree sub-rail inside the Rundeck pane. Lists every project upstream
 *  returns from `rnd_projects`, in the order Rundeck reports them —
 *  no Legacy/Product split, no hardcoded names. Each project's children
 *  (env folders) are derived from its job groups; projects whose jobs
 *  are flat collapse into a leaf row.
 *
 *  Env-folder rows named `production` get a subtle tint so the user
 *  can't miss them when picking a deploy target. */
export function RundeckProjectTree() {
  const projects = useResource(rndProjectsR);
  const activeProject = useStore((s) => s.rundeck.activeProject);
  const activeEnvFolder = useStore((s) => s.rundeck.activeEnvFolder);

  const list = projects.data ?? [];

  return (
    <aside className="rnd-tree">
      <div className="rnd-tree-section">
        {list.map((p) => (
          <ProjectRow
            key={p.name}
            project={p.name}
            activeProject={activeProject}
            activeEnvFolder={activeEnvFolder}
          />
        ))}
        {list.length === 0 && projects.status === "loading" && (
          <TreeHint>loading…</TreeHint>
        )}
        {list.length === 0 && projects.status === "ok" && (
          <TreeHint>no projects</TreeHint>
        )}
      </div>
      {projects.error && !projects.data && (
        <div className="rnd-tree-err">{projects.error}</div>
      )}
    </aside>
  );
}

function TreeHint({ children }: { children: React.ReactNode }) {
  return <div className="rnd-tree-hint">{children}</div>;
}

function ProjectRow({
  project,
  activeProject,
  activeEnvFolder,
}: {
  project: string;
  activeProject: string;
  activeEnvFolder: string | null;
}) {
  // Fetch jobs to determine whether this project has env folders. One
  // call per project, cached. If any job's group has a slash, render
  // expandable; otherwise it's a flat leaf.
  const jobs = useResource(rndJobsR, project);
  const folders = useMemo(() => {
    const map = new Map<string, number>();
    for (const j of jobs.data ?? []) {
      const folder = envFolderOf(j.group);
      if (!folder) continue;
      map.set(folder, (map.get(folder) ?? 0) + 1);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [jobs.data]);

  const isActiveProject = project === activeProject;
  const hasFolders = folders.length > 0;
  const expanded = isActiveProject || hasFolders;

  return (
    <div className="rnd-tree-group">
      <button
        type="button"
        className={`rnd-tree-row${
          isActiveProject && activeEnvFolder === null ? " active" : ""
        }`}
        onClick={() => cmd.setRundeckProject(project, null)}
        title={project}
      >
        <span className="rnd-tree-chev">
          {hasFolders ? (
            <IconChevron
              size={9}
              className={`rnd-tree-chev-ic${expanded ? " open" : ""}`}
            />
          ) : null}
        </span>
        <span className="rnd-tree-ic">
          <IconFolder size={11} />
        </span>
        <span className="rnd-tree-name">{project}</span>
      </button>
      {expanded && hasFolders && (
        <div className="rnd-tree-children">
          {folders.map(([folder, count]) => {
            const isLeafActive =
              isActiveProject && activeEnvFolder === folder;
            const isProd = folder.toLowerCase() === "production";
            return (
              <button
                type="button"
                key={folder}
                className={`rnd-tree-leaf${isLeafActive ? " active" : ""}${isProd ? " prod" : ""}`}
                onClick={() => cmd.setRundeckProject(project, folder)}
                title={`${project} · ${folder}/`}
              >
                <span className="rnd-tree-leaf-name">{folder}/</span>
                <span className="rnd-tree-leaf-n">{count}</span>
              </button>
            );
          })}
          {folders.length === 0 && jobs.status === "loading" && (
            <div className="rnd-tree-hint indent">loading…</div>
          )}
        </div>
      )}
    </div>
  );
}

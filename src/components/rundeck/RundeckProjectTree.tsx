import { useMemo } from "react";
import * as cmd from "../../state/commands";
import { useResource } from "../../state/resources";
import { rndJobsR, rndProjectsR } from "../../state/resources.defs";
import { envFolderOf, isLegacyProject } from "../../state/rundeckShape";
import { useStore } from "../../state/store";
import { IconChevron, IconFolder } from "../Icons";

/** Tree sub-rail inside the Rundeck pane. Two sections:
 *
 *  - **Legacy** (env-as-project): single row per project, no children.
 *    Selecting jumps the matrix to that project's flat job list.
 *  - **Product**: row per project + indented env-folder children
 *    (`dev/`, `production/`) derived from `rnd_jobs`. Selecting the
 *    project header shows all env folders grouped; selecting an env
 *    folder narrows the matrix to that subtree.
 *
 *  Production-tier rows (legacy `production`, product env folder
 *  `production`) are tinted so the user can't miss them when picking. */
export function RundeckProjectTree() {
  const projects = useResource(rndProjectsR);
  const activeProject = useStore((s) => s.rundeck.activeProject);
  const activeEnvFolder = useStore((s) => s.rundeck.activeEnvFolder);

  const { legacy, product } = useMemo(() => {
    const all = projects.data ?? [];
    return {
      legacy: all.filter((p) => isLegacyProject(p.name)),
      product: all.filter((p) => !isLegacyProject(p.name)),
    };
  }, [projects.data]);

  return (
    <aside className="rnd-tree">
      <Section label="Legacy">
        {legacy.map((p) => (
          <LegacyRow
            key={p.name}
            project={p.name}
            active={p.name === activeProject}
          />
        ))}
        {legacy.length === 0 && projects.status === "loading" && (
          <TreeHint>loading…</TreeHint>
        )}
      </Section>
      <Section label="Product">
        {product.map((p) => (
          <ProductRow
            key={p.name}
            project={p.name}
            activeProject={activeProject}
            activeEnvFolder={activeEnvFolder}
          />
        ))}
        {product.length === 0 && projects.status === "loading" && (
          <TreeHint>loading…</TreeHint>
        )}
      </Section>
      {projects.error && !projects.data && (
        <div className="rnd-tree-err">{projects.error}</div>
      )}
    </aside>
  );
}

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rnd-tree-section">
      <div className="rnd-tree-section-h">{label}</div>
      {children}
    </div>
  );
}

function TreeHint({ children }: { children: React.ReactNode }) {
  return <div className="rnd-tree-hint">{children}</div>;
}

function LegacyRow({
  project,
  active,
}: {
  project: string;
  active: boolean;
}) {
  const isProd = project.toLowerCase() === "production";
  return (
    <button
      type="button"
      className={`rnd-tree-row${active ? " active" : ""}${isProd ? " prod" : ""}`}
      onClick={() => cmd.setRundeckProject(project, null)}
      title={`${project} (legacy)`}
    >
      <span className="rnd-tree-chev" aria-hidden />
      <span className="rnd-tree-ic">
        <IconFolder size={11} />
      </span>
      <span className="rnd-tree-name">{project}</span>
    </button>
  );
}

function ProductRow({
  project,
  activeProject,
  activeEnvFolder,
}: {
  project: string;
  activeProject: string;
  activeEnvFolder: string | null;
}) {
  // We always fetch jobs for each product project so the tree can show
  // env-folder children + counts. Lightweight (one API call per
  // product, cached) and lets the user navigate without first having to
  // select the project.
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
  const expanded = isActiveProject || folders.length > 0;

  return (
    <div className="rnd-tree-group">
      <button
        type="button"
        className={`rnd-tree-row${isActiveProject && activeEnvFolder === null ? " active" : ""}`}
        onClick={() => cmd.setRundeckProject(project, null)}
        title={`${project} (product) — all env folders`}
      >
        <span className="rnd-tree-chev">
          <IconChevron
            size={9}
            className={`rnd-tree-chev-ic${expanded ? " open" : ""}`}
          />
        </span>
        <span className="rnd-tree-ic">
          <IconFolder size={11} />
        </span>
        <span className="rnd-tree-name">{project}</span>
      </button>
      {expanded && (
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
                title={`${project} · ${folder}/backend`}
              >
                <span className="rnd-tree-leaf-name">{folder}/</span>
                <span className="rnd-tree-leaf-n">{count}</span>
              </button>
            );
          })}
          {folders.length === 0 && jobs.status === "loading" && (
            <div className="rnd-tree-hint indent">loading…</div>
          )}
          {folders.length === 0 && jobs.status !== "loading" && (
            <div className="rnd-tree-hint indent muted">no jobs</div>
          )}
        </div>
      )}
    </div>
  );
}

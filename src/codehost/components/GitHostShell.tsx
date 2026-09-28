import { lazy, Suspense, useState, type ReactNode } from "react";
import { SkeletonRows } from "../../plugin-api/ui";
import type { GitArea } from "../../state/types";
import { useHostRepo } from "../project";
import { codeHost, HostProvider } from "../registry";
import { sameRepo, setProjectRepo, slugOf } from "../state";
import { HostStrip } from "./HostStrip";

const HostArea = lazy(() => import("./HostArea").then((module) => ({ default: module.HostArea })));
const RepoPicker = lazy(() => import("./RepoPicker").then((module) => ({ default: module.RepoPicker })));

interface Props {
    paneId: string;
    /** The repository folder the git pane is on. */
    cwd: string;
    area: GitArea;
    active: boolean;
    onArea: (area: GitArea) => void;
    /** The local workbench, shown while the area is `local` or the folder is on no known host. */
    children: ReactNode;
}

/**
 * Puts the code host the folder's remote lives on beside the local workbench. A folder on no known host, or on one
 * whose plugin is switched off, gets the workbench alone.
 */
export function GitHostShell({ paneId, cwd, area, active, onArea, children }: Props) {
    const found = useHostRepo(cwd, active);
    const host = found.repo ? codeHost(found.repo.provider) : undefined;
    const [picking, setPicking] = useState(false);
    if (!host || !found.repo) return <>{children}</>;
    const repo = found.repo;

    return (
        <HostProvider value={host}>
            <HostStrip area={area} slug={slugOf(repo)} active={active} onArea={onArea} onPickRepo={() => setPicking(true)} />
            {area === "local" ? (
                children
            ) : (
                <Suspense fallback={<SkeletonRows rows={8} label={`Loading ${host.name}`} />}>
                    <HostArea
                        paneId={paneId}
                        section={area}
                        repo={repo}
                        branch={found.branch}
                        cwd={sameRepo(found.remote, repo) ? cwd : null}
                        active={active}
                    />
                </Suspense>
            )}
            {picking && (
                <Suspense fallback={null}>
                    <RepoPicker
                        current={repo}
                        onClose={() => setPicking(false)}
                        onPick={(picked) =>
                            setProjectRepo(host.id, cwd, found.remote && slugOf(found.remote) === slugOf(picked) ? null : slugOf(picked))
                        }
                    />
                </Suspense>
            )}
        </HostProvider>
    );
}

import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from "react";
import { AuthorPicturesProvider, type AuthorPictures } from "../../components/git/AuthorAvatar";
import { invalidate, useResourceEnabled } from "../../plugin-api/resources";
import { subscribe } from "../../state/bus";
import { SkeletonRows } from "../../plugin-api/ui";
import type { GitArea } from "../../state/types";
import type { RepoRef } from "../types";
import { useHostRepo } from "../project";
import { commitAuthorsR, hostStatusR } from "../resources";
import { codeHost, HostProvider, type CodeHost } from "../registry";
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
    const hosted = !!host;
    const pictures = useAuthorPictures(host, found.repo, active);

    // A push, pull or commit changes what the host has to say about this repository's branches and pull requests.
    useEffect(() => {
        if (!hosted) return;
        return subscribe("git-refresh", (event) => {
            if (event.repo !== cwd) return;
            invalidate(
                (kind) =>
                    kind === "host.runs" ||
                    kind === "host.pulls" ||
                    kind === "host.pull" ||
                    kind === "host.timeline" ||
                    kind === "host.pullCommits" ||
                    kind === "host.pullFiles",
            );
        });
    }, [cwd, hosted]);

    if (!host || !found.repo) return <>{children}</>;
    const repo = found.repo;

    return (
        <HostProvider value={host}>
            <HostStrip area={area} slug={slugOf(repo)} active={active} onArea={onArea} onPickRepo={() => setPicking(true)} />
            {area === "local" ? (
                <AuthorPicturesProvider value={pictures}>{children}</AuthorPicturesProvider>
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

/** The host's pictures for the emails in local commits, once someone is signed in to it. */
function useAuthorPictures(host: CodeHost | undefined, repo: RepoRef | null, active: boolean): AuthorPictures | null {
    const provider = repo?.provider ?? "";
    const status = useResourceEnabled(active && !!host, hostStatusR, provider);
    const signedIn = !!status.data?.ok;
    const authors = useResourceEnabled(
        active && signedIn && !!host?.api.commitAuthors,
        commitAuthorsR,
        repo ?? { provider, owner: "", name: "" },
        null,
    );
    return useMemo(() => {
        if (!host || !signedIn) return null;
        const byEmail = new Map((authors.data ?? []).map((author) => [author.email.toLowerCase(), author.avatarUrl]));
        return {
            pictureFor: (email) => host.avatarForEmail?.(email) ?? byEmail.get(email.toLowerCase()) ?? null,
            load: (url) => host.api.image(url),
        };
    }, [host, signedIn, authors.data]);
}

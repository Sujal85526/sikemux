import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from "react";
import { AuthorPicturesProvider, type AuthorPictures } from "../../git/AuthorAvatar";
import { invalidate, useCachedResourceEnabled } from "../../plugin-api/resources";
import { subscribe } from "../../state/bus";
import { SkeletonRows } from "../../plugin-api/ui";
import type { GitArea } from "../../state/types";
import type { RepoRef } from "../types";
import { useHostRepo } from "../project";
import { commitAuthorsR, hostStatusR } from "../resources";
import { AccountProvider, codeHost, HostProvider, type CodeHost } from "../registry";
import { sameRepo, setProjectAccount, setProjectRepo, slugOf } from "../state";
import { GitNav, HostAccountButton, HostNavItems, type NavItem } from "./HostRail";

const HostArea = lazy(() => import("./HostArea").then((module) => ({ default: module.HostArea })));
const RepoPicker = lazy(() => import("./RepoPicker").then((module) => ({ default: module.RepoPicker })));

interface Props {
    paneId: string;
    /** The repository folder the git pane is on. */
    cwd: string;
    area: GitArea;
    active: boolean;
    /** Whether the pane is on screen and settled, so its host data may be read. */
    fetching: boolean;
    onArea: (area: GitArea) => void;
    /** The local workbench's screens, which head the navigation. */
    local: readonly NavItem[];
    /** The local workbench's own controls, shown in the header beside the navigation while it is open. */
    tools?: ReactNode;
    /** The local workbench, shown while the area is `local` or the folder is on no known host. */
    children: ReactNode;
}

/**
 * The git pane's header and whatever it has open. The code host the folder's remote lives on adds its sections to the
 * header; a folder on no known host, or on one whose plugin is switched off, gets the local screens alone.
 */
export function GitHostShell({ paneId, cwd, area, active, fetching, onArea, local, tools, children }: Props) {
    const found = useHostRepo(cwd, fetching);
    const host = found.repo ? codeHost(found.repo.provider) : undefined;
    const [picking, setPicking] = useState(false);
    const [adding, setAdding] = useState(false);
    const hosted = !!host;
    const pictures = useAuthorPictures(host, found.repo, fetching);

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

    const repo = host ? found.repo : null;
    const added = (account: string | null) => {
        if (host && account) setProjectAccount(host.id, cwd, account);
        setAdding(false);
        invalidate((kind) => kind.startsWith("host."));
    };

    return (
        <HostProvider value={host && repo ? host : null}>
            <AccountProvider value={repo?.account ?? null}>
                <div className="git-shell">
                    <GitNav
                        local={local}
                        host={host && repo ? <HostNavItems area={area} onArea={onArea} /> : undefined}
                        tools={!repo || (area === "local" && !adding) ? tools : null}
                        account={
                            host && repo ? (
                                <HostAccountButton
                                    slug={slugOf(repo)}
                                    cwd={cwd}
                                    active={active}
                                    onSignIn={() => onArea("pulls")}
                                    onPickRepo={() => setPicking(true)}
                                    onAddAccount={() => setAdding(true)}
                                />
                            ) : undefined
                        }
                    />
                    <div className="git-shell-main">
                        {host && repo && adding ? (
                            <div className="gha-pane" data-active={active ? "1" : "0"}>
                                <div className="gha-callout gha-add-account">
                                    <span>Add another {host.name} account. This project switches to it once it signs in.</span>
                                    <button type="button" className="gha-link" onClick={() => setAdding(false)}>
                                        Cancel
                                    </button>
                                </div>
                                <host.SignIn onSignedIn={added} />
                            </div>
                        ) : !host || !repo || area === "local" ? (
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
                    </div>
                </div>
                {host && repo && picking && (
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
            </AccountProvider>
        </HostProvider>
    );
}

/** The host's pictures for the emails in local commits, once someone is signed in to it. */
function useAuthorPictures(host: CodeHost | undefined, repo: RepoRef | null, fetching: boolean): AuthorPictures | null {
    const provider = repo?.provider ?? "";
    const status = useCachedResourceEnabled(fetching && !!host, hostStatusR, provider, repo?.account ?? null);
    const signedIn = !!status.data?.ok;
    const authors = useCachedResourceEnabled(
        fetching && signedIn && !!host?.api.commitAuthors,
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

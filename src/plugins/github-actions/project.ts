import { git, gitOverviewR, useActiveProjectCwd } from "../../plugin-api/host";
import { resource, useResourceEnabled } from "../../plugin-api/resources";
import { actionsApi, type RepoRef } from "./api";
import { actionsSettings, refOf } from "./state";

export const gitRemotesR = resource({
    kind: "gha.gitRemotes",
    fetch: (cwd: string) => git.remotes(cwd),
    staleAfterMs: 60_000,
});

/** `origin` is what people push to, so it is the remote that names the repository. */
export function pickRemote(remotes: readonly { name: string; url: string }[]): string | null {
    const origin = remotes.find((remote) => remote.name === "origin");
    return (origin ?? remotes[0])?.url ?? null;
}

export const remoteRepoR = resource({
    kind: "gha.remoteRepo",
    fetch: async (cwd: string): Promise<RepoRef | null> => {
        const url = pickRemote(await git.remotes(cwd));
        if (!url) return null;
        const resolved = await actionsApi.resolveRemote(url);
        return resolved.repo ? { owner: resolved.repo.owner, name: resolved.repo.name } : null;
    },
    staleAfterMs: 5 * 60_000,
});

export interface ProjectRepo {
    cwd: string | null;
    repo: RepoRef | null;
    branch: string | null;
    /** True while the folder's remote is still being read, so nothing has been ruled out yet. */
    loading: boolean;
}

/**
 * The repository behind the project in front, and the branch it is on. A
 * repository chosen by hand for that folder wins over whatever its remote says.
 */
export function useProjectRepo(enabled: boolean): ProjectRepo {
    const cwd = useActiveProjectCwd();
    const chosen = actionsSettings.useSelect((settings) => (cwd ? (settings.repoByProject[cwd] ?? null) : null));
    const overridden = chosen ? refOf(chosen) : null;
    const fromRemote = useResourceEnabled(enabled && !!cwd && !overridden, remoteRepoR, cwd ?? "");
    const overview = useResourceEnabled(enabled && !!cwd, gitOverviewR, cwd ?? "");
    return {
        cwd,
        repo: overridden ?? fromRemote.data ?? null,
        branch: overview.data?.status.branch ?? null,
        loading: !!cwd && !overridden && fromRemote.status === "loading" && !fromRemote.data,
    };
}

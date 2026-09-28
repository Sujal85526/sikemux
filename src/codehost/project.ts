import { useMemo } from "react";
import { git, gitOverviewR } from "../plugin-api/host";
import { resource, useResourceEnabled } from "../plugin-api/resources";
import { enabledCodeHosts } from "./registry";
import { hostSettings, refOf } from "./state";
import type { RepoRef } from "./types";

/** `origin` is what people push to, so it is the remote that names the repository. */
export function pickRemote(remotes: readonly { name: string; url: string }[]): string | null {
    const origin = remotes.find((remote) => remote.name === "origin");
    return (origin ?? remotes[0])?.url ?? null;
}

/** The repository a folder's remote points at, on the first enabled host that recognises it. */
export const remoteRepoR = resource({
    kind: "host.remoteRepo",
    fetch: async (cwd: string): Promise<RepoRef | null> => {
        const url = pickRemote(await git.remotes(cwd));
        if (!url) return null;
        for (const host of enabledCodeHosts()) {
            const resolved = await host.api.resolveRemote(url).catch(() => null);
            if (resolved?.repo) return { provider: host.id, owner: resolved.repo.owner, name: resolved.repo.name };
        }
        return null;
    },
    staleAfterMs: 5 * 60_000,
});

export interface HostRepo {
    /** The repository the host sections show, which a hand-picked one for this folder overrides. */
    repo: RepoRef | null;
    /** The one the folder's remote points at, before any hand-picked override. */
    remote: RepoRef | null;
    branch: string | null;
    /** True while the folder's remote is still being read, so nothing has been ruled out yet. */
    loading: boolean;
}

export function useHostRepo(cwd: string | null, enabled: boolean): HostRepo {
    const fromRemote = useResourceEnabled(enabled && !!cwd, remoteRepoR, cwd ?? "");
    const overview = useResourceEnabled(enabled && !!cwd, gitOverviewR, cwd ?? "");
    const remote = fromRemote.data ?? null;
    const provider = remote?.provider ?? "";
    const chosen = hostSettings(provider).useSelect((settings) => (cwd && provider ? (settings.repoByProject[cwd] ?? null) : null));
    const overridden = useMemo(() => (chosen ? refOf(provider, chosen) : null), [chosen, provider]);
    return {
        repo: overridden ?? remote,
        remote,
        branch: overview.data?.status.branch ?? null,
        loading: !!cwd && fromRemote.status === "loading" && !fromRemote.data,
    };
}

import { describe, expect, it } from "vitest";
import { claimRemote, pickRemote, pullsByBranch } from "./project";
import type { CodeHost } from "./registry";
import type { Pull } from "./types";

describe("pickRemote", () => {
    it("takes origin, which is what people push to", () => {
        expect(
            pickRemote([
                { name: "upstream", url: "git@github.com:nodelike/sikemux.git" },
                { name: "origin", url: "git@github.com:someone/sikemux.git" },
            ]),
        ).toBe("git@github.com:someone/sikemux.git");
    });

    it("falls back to the only remote there is when none is called origin", () => {
        expect(pickRemote([{ name: "upstream", url: "git@github.com:nodelike/sikemux.git" }])).toBe("git@github.com:nodelike/sikemux.git");
    });

    it("has nothing to pick in a repository with no remotes", () => {
        expect(pickRemote([])).toBeNull();
    });
});

describe("pullsByBranch", () => {
    const repo = { provider: "test.host", owner: "nodelike", name: "sikemux" };
    const pull = (number: number, head: string, owner: string) => ({ number, head, headLabel: `${owner}:${head}` }) as Pull;

    it("finds each of the repository's own branches' pull request", () => {
        const found = pullsByBranch([pull(1, "feat/a", "nodelike"), pull(2, "fix/b", "nodelike")], repo);
        expect(found.get("feat/a")?.number).toBe(1);
        expect(found.get("fix/b")?.number).toBe(2);
    });

    it("leaves out a fork's, whose branch only shares a name with one here", () => {
        expect(pullsByBranch([pull(49, "main", "Sujal85526")], repo).has("main")).toBe(false);
    });
});

describe("claimRemote", () => {
    const host = (id: string, server: string) =>
        ({
            id,
            api: {
                resolveRemote: (url: string) =>
                    Promise.resolve({
                        repo: { host: new URL(url).host, owner: "team", name: "thing" },
                        slug: "team/thing",
                        sameHost: new URL(url).host === server,
                    }),
            },
        }) as unknown as Pick<CodeHost, "id" | "api">;

    it("goes to the host whose server the remote is on", async () => {
        const hosts = [host("github", "github.com"), host("bitbucket", "bitbucket.org")];
        expect(await claimRemote("https://bitbucket.org/team/thing.git", hosts)).toEqual({ provider: "bitbucket", owner: "team", name: "thing" });
    });

    it("leaves a remote no host serves to the local workbench, even when a host can read its address", async () => {
        expect(await claimRemote("https://gitlab.com/team/thing.git", [host("github", "github.com")])).toBeNull();
    });
});

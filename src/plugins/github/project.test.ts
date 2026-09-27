import { describe, expect, it } from "vitest";
import { pickRemote } from "./project";

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

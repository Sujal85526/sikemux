import { describe, expect, it } from "vitest";
import { computeGraph } from "./GitGraph";
import type { GitCommit } from "../../api/git";

/** A straight chain, newest first: c0 is the child of c1, and so on. */
function chain(count: number): GitCommit[] {
    return Array.from({ length: count }, (_, i) => ({
        hash: `c${i}`,
        full_hash: `full-c${i}`,
        parents: i + 1 < count ? [`full-c${i + 1}`] : [],
        author: "sikemux",
        author_email: "sikemux@example.test",
        date: "1m ago",
        subject: `commit ${i}`,
        refs: i === 0 ? ["HEAD"] : [],
        unpushed: false,
    }));
}

describe("computeGraph", () => {
    it("draws a straight chain in one lane", () => {
        const { rows, maxLanes } = computeGraph(chain(6));
        expect(maxLanes).toBe(1);
        expect(rows.every((r) => r.lane === 0 && r.through.length === 0)).toBe(true);
    });

    it("closes the lane when a parent arrives before its own child", () => {
        const commits = chain(6);
        [commits[2], commits[3]] = [commits[3], commits[2]];

        const { rows } = computeGraph(commits);

        expect(rows.slice(4).every((r) => r.through.length === 0)).toBe(true);
    });
});

import { describe, expect, it } from "vitest";
import type { Job, LogLine, Step } from "./api";
import { splitName, stagesOf, stepStarts } from "./jobGraph";

function job(id: number, name: string, startedAt: string | null, completedAt: string | null, status = "completed"): Job {
    return {
        id,
        name,
        status,
        conclusion: status === "completed" ? "success" : null,
        startedAt,
        completedAt,
        runner: null,
        url: null,
        checkRunId: null,
        steps: [],
    };
}

const at = (minute: number) => `2026-09-27T10:${String(minute).padStart(2, "0")}:00Z`;

describe("splitName", () => {
    it("reads the calling workflow off a job's name", () => {
        expect(splitName("Checks / Rust formatting")).toEqual({ group: "Checks", label: "Rust formatting" });
        expect(splitName("Build, verify, and publish")).toEqual({ group: null, label: "Build, verify, and publish" });
        expect(splitName(" / odd")).toEqual({ group: null, label: " / odd" });
    });
});

describe("stagesOf", () => {
    it("puts a called workflow's jobs in one box and what waited for it after", () => {
        const stages = stagesOf([
            job(1, "Checks / Frontend", at(0), at(3)),
            job(2, "Checks / Rust", at(0), at(3)),
            job(3, "Checks / macOS", at(1), at(7)),
            job(4, "Build, verify, and publish", at(8), at(28)),
        ]);
        expect(stages).toHaveLength(2);
        expect(stages[0]).toHaveLength(1);
        expect(stages[0]?.[0]?.title).toBe("Checks");
        expect(stages[0]?.[0]?.jobs.map((each) => each.label)).toEqual(["Frontend", "Rust", "macOS"]);
        expect(stages[1]?.[0]?.jobs[0]?.label).toBe("Build, verify, and publish");
    });

    it("keeps jobs that overlapped side by side", () => {
        const stages = stagesOf([job(1, "lint", at(0), at(2)), job(2, "test", at(1), at(5))]);
        expect(stages).toHaveLength(1);
        expect(stages[0]).toHaveLength(2);
    });

    it("never starts a stage after one that is still going", () => {
        const stages = stagesOf([job(1, "build", at(0), null, "in_progress"), job(2, "late", at(9), null, "in_progress")]);
        expect(stages).toHaveLength(1);
    });

    it("puts jobs that have not started at the end", () => {
        const stages = stagesOf([job(1, "deploy", null, null, "queued"), job(2, "build", at(0), at(2))]);
        expect(stages.map((stage) => stage.map((group) => group.jobs[0]?.label))).toEqual([["build"], ["deploy"]]);
    });

    it("has nothing to draw for a run with no jobs", () => {
        expect(stagesOf([])).toEqual([]);
    });
});

describe("stepStarts", () => {
    const line = (number: number, second: number): LogLine => ({
        number,
        timestamp: `2026-09-27T10:00:${String(second).padStart(2, "0")}.5000000Z`,
        text: `line ${number}`,
    });
    const step = (number: number, second: number | null): Step => ({
        number,
        name: `step ${number}`,
        status: "completed",
        conclusion: "success",
        startedAt: second === null ? null : `2026-09-27T10:00:${String(second).padStart(2, "0")}Z`,
        completedAt: null,
    });

    it("finds the first line each step wrote", () => {
        const lines = [line(1, 0), line(2, 1), line(3, 4), line(4, 4), line(5, 9)];
        const starts = stepStarts(lines, [step(1, 0), step(2, 4), step(3, 9)]);
        expect([...starts]).toEqual([
            [1, 0],
            [2, 2],
            [3, 4],
        ]);
    });

    it("skips a step that never ran and one that wrote nothing", () => {
        const starts = stepStarts([line(1, 0)], [step(1, null), step(2, 0), step(3, 30)]);
        expect([...starts]).toEqual([[2, 0]]);
    });
});

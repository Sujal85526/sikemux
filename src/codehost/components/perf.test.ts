import { describe, expect, it } from "vitest";
import { mayBeWaiting } from "./Approvals";
import { SUMMARY_LIMIT, summaryJobs } from "../runStatus";
import { coarse } from "./hooks";

describe("mayBeWaiting", () => {
    it("asks GitHub only about a run it could actually be holding", () => {
        expect(mayBeWaiting("waiting", null)).toBe(true);
        expect(mayBeWaiting("action_required", null)).toBe(true);
        expect(mayBeWaiting("completed", "action_required")).toBe(true);
    });

    it("spends no request on a run nobody has to sign off", () => {
        expect(mayBeWaiting("completed", "success")).toBe(false);
        expect(mayBeWaiting("in_progress", null)).toBe(false);
        expect(mayBeWaiting("queued", null)).toBe(false);
    });
});

describe("coarse", () => {
    it("holds still within the minute, so a row reading 3h ago is not redrawn every second", () => {
        const base = Date.parse("2026-01-01T12:00:00Z");
        expect(coarse(base)).toBe(coarse(base + 59_000));
    });

    it("moves on once the minute does", () => {
        const base = Date.parse("2026-01-01T12:00:00Z");
        expect(coarse(base + 60_000)).toBeGreaterThan(coarse(base));
    });
});

describe("summaryJobs", () => {
    const job = (id: number, conclusion = "success", checkRunId: number | null = id) => ({
        id,
        name: `job ${id}`,
        status: "completed",
        conclusion,
        startedAt: null,
        completedAt: null,
        runner: null,
        url: null,
        checkRunId,
        steps: [],
    });

    it("asks for nothing while the run is still going", () => {
        expect(summaryJobs([job(1)], false, true)).toEqual([]);
    });

    it("skips jobs that could not have written one", () => {
        const found = summaryJobs([job(1), job(2, "skipped"), job(3, "success", null)], true, false);
        expect(found.map((each) => each.id)).toEqual([1]);
    });

    it("only loads the first few of a wide matrix until asked for the rest", () => {
        const wide = Array.from({ length: SUMMARY_LIMIT + 5 }, (_, index) => job(index + 1));
        expect(summaryJobs(wide, true, false)).toHaveLength(SUMMARY_LIMIT);
        expect(summaryJobs(wide, true, true)).toHaveLength(SUMMARY_LIMIT + 5);
    });
});

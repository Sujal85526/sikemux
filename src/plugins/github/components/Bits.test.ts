import { describe, expect, it } from "vitest";
import { readableOn } from "./Bits";
import { reasonLabel } from "./InboxView";
import { reviewVerdict } from "./PullsView";

describe("readableOn", () => {
    it("puts dark text on a pale label and light text on a dark one", () => {
        expect(readableOn("fbca04")).toBe("dark");
        expect(readableOn("ffffff")).toBe("dark");
        expect(readableOn("0e8a16")).toBe("light");
        expect(readableOn("000000")).toBe("light");
        expect(readableOn("d73a4a")).toBe("light");
    });

    it("copes with a hash and with nonsense", () => {
        expect(readableOn("#ffffff")).toBe("dark");
        expect(readableOn("nope")).toBe("light");
        expect(readableOn("")).toBe("light");
    });
});

describe("reviewVerdict", () => {
    const review = (author: string, state: string) => ({ author, state });

    it("says nothing until somebody has reviewed", () => {
        expect(reviewVerdict([])).toBeNull();
        expect(reviewVerdict([review("a", "COMMENTED")])).toBeNull();
    });

    it("reports an approval", () => {
        expect(reviewVerdict([review("a", "APPROVED")])).toBe("Approved");
    });

    it("lets requested changes outweigh an approval", () => {
        expect(reviewVerdict([review("a", "APPROVED"), review("b", "CHANGES_REQUESTED")])).toBe("Changes requested");
    });

    it("counts only a person's latest review", () => {
        expect(reviewVerdict([review("a", "CHANGES_REQUESTED"), review("a", "APPROVED")])).toBe("Approved");
    });

    it("ignores a review that was dismissed", () => {
        expect(reviewVerdict([review("a", "APPROVED"), review("b", "DISMISSED")])).toBe("Approved");
    });
});

describe("reasonLabel", () => {
    it("writes GitHub's reason codes as words", () => {
        expect(reasonLabel("review_requested")).toBe("Review requested");
        expect(reasonLabel("ci_activity")).toBe("CI finished");
    });

    it("makes an unknown reason readable rather than dropping it", () => {
        expect(reasonLabel("something_new")).toBe("something new");
    });
});

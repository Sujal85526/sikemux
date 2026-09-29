import { describe, expect, it } from "vitest";
import type { RateLimit } from "../types";
import { rateLimitNote, waitInWords } from "./RateLimitBanner";

const plenty: RateLimit = { limited: false, resetsAt: null, remaining: 4800, limit: 5000, near: false };
const now = Date.UTC(2026, 8, 29, 10, 0, 0);

describe("rateLimitNote", () => {
    it("says nothing while there is plenty left", () => {
        expect(rateLimitNote("GitHub", plenty, now)).toBeNull();
    });

    it("says how long requests are held back once the limit is spent", () => {
        const spent = { ...plenty, limited: true, remaining: 0, resetsAt: now / 1000 + 12 * 60 };
        const note = rateLimitNote("GitHub", spent, now);
        expect(note?.tone).toBe("danger");
        expect(note?.text).toMatch(/^GitHub's rate limit is used up\. Sikemux is holding requests until .+, in 12 min\.$/);
    });

    it("counts what is left when the host says", () => {
        const low = { ...plenty, remaining: 120, near: true };
        expect(rateLimitNote("GitHub", low, now)).toEqual({ tone: "warn", text: "120 of 5000 GitHub requests left this hour." });
    });

    it("warns without numbers when the host only says it is close", () => {
        const close = { limited: false, resetsAt: null, remaining: null, limit: null, near: true };
        expect(rateLimitNote("Bitbucket", close, now)).toEqual({ tone: "warn", text: "Close to Bitbucket's hourly request limit." });
    });
});

describe("waitInWords", () => {
    it("rounds up to what a person would wait", () => {
        expect(waitInWords(400)).toBe("1s");
        expect(waitInWords(45_000)).toBe("45s");
        expect(waitInWords(61_000)).toBe("2 min");
        expect(waitInWords(125 * 60_000)).toBe("2 h 5 min");
    });
});

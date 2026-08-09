import { describe, expect, it } from "vitest";
import { createPreviewHistory, currentPreviewUrl, localPreviewUrl, movePreviewHistory, pushPreviewHistory } from "./preview";

describe("local preview navigation", () => {
    it("normalizes loopback URLs and rejects remote or credential-bearing pages", () => {
        expect(localPreviewUrl("localhost:5173/app")).toBe("http://localhost:5173/app");
        expect(localPreviewUrl("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000/");
        expect(localPreviewUrl("https://example.com")).toBeNull();
        expect(localPreviewUrl("http://user:secret@localhost:3000")).toBeNull();
        expect(localPreviewUrl("file:///tmp/index.html")).toBeNull();
    });

    it("keeps bounded browser-style history when navigating after going back", () => {
        let history = createPreviewHistory("localhost:3000");
        history = pushPreviewHistory(history, "localhost:3000/docs");
        history = pushPreviewHistory(history, "localhost:3000/settings");
        history = movePreviewHistory(history, -1);
        expect(currentPreviewUrl(history)).toContain("/docs");
        history = pushPreviewHistory(history, "localhost:3000/review");
        expect(history.entries).toHaveLength(3);
        expect(history.entries.some((entry) => entry.includes("settings"))).toBe(false);
    });
});

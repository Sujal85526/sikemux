import { describe, expect, it, vi } from "vitest";
import { fsapi } from "../api/fs";
import { localImagePath, localPath, previewCacheBytes, useImagePreview } from "./imagePreview";
import { act, renderHook, waitFor } from "@testing-library/react";

describe("chat image previews", () => {
    it("decodes the file URL an agent writes for an attachment", () => {
        expect(localImagePath("file:///Users/me/Screenshots/Shot%202026-09-16%20at%205.31.48%E2%80%AFPM.png")).toBe(
            "/Users/me/Screenshots/Shot 2026-09-16 at 5.31.48\u202fPM.png",
        );
    });

    it("takes a plain absolute path as it is", () => {
        expect(localImagePath("/tmp/diagram.jpeg")).toBe("/tmp/diagram.jpeg");
    });

    it("drops the leading slash a Windows file URL carries", () => {
        expect(localImagePath("file:///C:/Users/me/shot.png")).toBe("C:/Users/me/shot.png");
    });

    it("has no preview for files that are not images", () => {
        expect(localImagePath("file:///Users/me/notes.md")).toBeNull();
        expect(localPath("file:///Users/me/notes.md")).toBe("/Users/me/notes.md");
    });

    it("holds only a handful of thumbnails at a time", async () => {
        const megabyte = "A".repeat(1024 * 1024);
        vi.spyOn(fsapi, "readFileBase64").mockResolvedValue({ mime: "image/png", data: megabyte, size: 1024 });

        for (let index = 0; index < 20; index += 1) {
            const { unmount } = renderHook(() => useImagePreview(`/shots/${index}.png`));
            await waitFor(() => expect(previewCacheBytes()).toBeGreaterThan(0));
            act(() => unmount());
        }

        expect(previewCacheBytes()).toBeLessThanOrEqual(12 * 1024 * 1024);
        vi.restoreAllMocks();
    });

    it("has no local path for remote links", () => {
        expect(localPath("https://example.com/cat.png")).toBeNull();
        expect(localImagePath("https://example.com/cat.png")).toBeNull();
    });
});

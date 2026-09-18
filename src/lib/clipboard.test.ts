import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* The module remembers that the async write failed, so each case needs it
   fresh rather than carrying the last test's verdict. */
async function load() {
    vi.resetModules();
    return import("./clipboard");
}

const originalClipboard = navigator.clipboard;

function stubClipboard(writeText: unknown) {
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
}

beforeEach(() => {
    document.execCommand = vi.fn(() => true);
});

afterEach(() => {
    Object.defineProperty(navigator, "clipboard", { value: originalClipboard, configurable: true });
    vi.restoreAllMocks();
});

describe("copyText", () => {
    it("uses the async clipboard when the platform allows it", async () => {
        const writeText = vi.fn(async () => {});
        stubClipboard(writeText);
        const { copyText } = await load();

        await copyText("branch-name");

        expect(writeText).toHaveBeenCalledWith("branch-name");
        expect(document.execCommand).not.toHaveBeenCalled();
    });

    it("falls back to a selection when the platform refuses", async () => {
        stubClipboard(vi.fn(async () => Promise.reject(new Error("NotAllowedError"))));
        const { copyText } = await load();

        await expect(copyText("the reply")).resolves.toBeUndefined();

        expect(document.execCommand).toHaveBeenCalledWith("copy");
        expect(document.querySelector("textarea")).toBeNull();
    });

    it("stops asking the async clipboard once it has refused", async () => {
        const writeText = vi.fn(async () => Promise.reject(new Error("NotAllowedError")));
        stubClipboard(writeText);
        const { copyText } = await load();

        await copyText("first");
        await copyText("second");

        expect(writeText).toHaveBeenCalledTimes(1);
        expect(document.execCommand).toHaveBeenCalledTimes(2);
    });

    it("reports a failure when neither path takes the text", async () => {
        stubClipboard(vi.fn(async () => Promise.reject(new Error("NotAllowedError"))));
        document.execCommand = vi.fn(() => false);
        const { copyText } = await load();

        await expect(copyText("nope")).rejects.toThrow("would not take the clipboard");
        expect(document.querySelector("textarea")).toBeNull();
    });
});

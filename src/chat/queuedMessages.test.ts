import { describe, expect, it } from "vitest";
import { combineQueued, nextBatch, queuedLabel, type QueuedMessage } from "./queuedMessages";

const queued = (id: string, text: string, paths: string[] = []): QueuedMessage => ({ id, text, paths });

describe("queuedLabel", () => {
    it("shows the text when there is some", () => {
        expect(queuedLabel(queued("1", "fix it", ["/a/b.png"]))).toBe("fix it");
    });

    it("names the attachments when there is no text", () => {
        expect(queuedLabel(queued("1", "", ["/a/b.png", "/c/d.txt"]))).toBe("b.png, d.txt");
    });
});

describe("nextBatch", () => {
    it("sends nothing from an empty queue", () => {
        expect(nextBatch([])).toEqual([]);
    });

    it("sends every plain message together", () => {
        const messages = [queued("1", "a"), queued("2", "b")];
        expect(nextBatch(messages)).toEqual(messages);
    });

    it("sends a leading command on its own", () => {
        const messages = [queued("1", "/compact"), queued("2", "b")];
        expect(nextBatch(messages)).toEqual([messages[0]]);
    });

    it("stops the batch before the next command", () => {
        const messages = [queued("1", "a"), queued("2", "b"), queued("3", "/review"), queued("4", "c")];
        expect(nextBatch(messages)).toEqual(messages.slice(0, 2));
    });
});

describe("combineQueued", () => {
    it("joins the texts and keeps the first id", () => {
        expect(combineQueued([queued("1", "a"), queued("2", ""), queued("3", "c")])).toEqual({ id: "1", text: "a\n\nc", paths: [] });
    });

    it("merges attachments without repeating one", () => {
        expect(combineQueued([queued("1", "a", ["/x", "/y"]), queued("2", "b", ["/y", "/z"])]).paths).toEqual(["/x", "/y", "/z"]);
    });
});

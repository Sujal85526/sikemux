import { describe, expect, it } from "vitest";
import { designedRowHeight, rowEstimator } from "./rowEstimate";
import type { ChatMessage, ChatPart } from "./types";

const reply = (id: string, parts: ChatPart[]): ChatMessage => ({ id, role: "assistant", parts });
const text = (id: string, body: string): ChatPart => ({ id, kind: "text", text: body });
const tool = (id: string): ChatPart => ({ id, kind: "tool", tool: { toolCallId: id, title: "Read" } }) as ChatPart;

describe("row height estimates", () => {
    it("guesses a long answer taller than a short one", () => {
        const short = reply("a", [text("t", "Done.")]);
        const long = reply("b", [text("t", "word ".repeat(2000))]);
        expect(designedRowHeight(long)).toBeGreaterThan(designedRowHeight(short) * 10);
    });

    it("counts a run of calls as the one line it folds into", () => {
        const one = reply("a", [tool("1")]);
        const many = reply("b", [tool("1"), tool("2"), tool("3")]);
        expect(designedRowHeight(many)).toBe(designedRowHeight(one));
    });

    it("scales its guesses by how the rows drawn so far compared", () => {
        const sizes = rowEstimator();
        const drawn = reply("a", [text("t", "A paragraph of answer.")]);
        const next = reply("b", [text("t", "Another paragraph.")]);
        const before = sizes.estimate(next);

        sizes.learn(drawn, designedRowHeight(drawn) * 2);
        expect(sizes.estimate(next)).toBe(before * 2);

        // Measuring the same row again replaces what it taught, rather than adding to it.
        sizes.learn(drawn, designedRowHeight(drawn));
        expect(sizes.estimate(next)).toBe(before);
    });
});

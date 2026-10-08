import { describe, expect, it } from "vitest";
import { designedRowHeight } from "./rowEstimate";
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
});

import { describe, expect, it } from "vitest";
import { collapseDiff, diffLines, toolDiff } from "./diff";
import type { AcpToolCall } from "./types";

const tool = (patch: Partial<AcpToolCall>): AcpToolCall => ({ toolCallId: "tool-1", title: "Edit", kind: "edit", ...patch });

describe("diffLines", () => {
    it("numbers both sides and keeps what did not change", () => {
        const lines = diffLines("a\nb\nc\n", "a\nB\nc\n");
        expect(lines?.map((line) => `${line.sign}${line.text}`)).toEqual([" a", "-b", "+B", " c"]);
        expect(lines?.[0]).toMatchObject({ oldLine: 1, newLine: 1 });
        expect(lines?.[1]).toMatchObject({ oldLine: 2 });
        expect(lines?.[2]).toMatchObject({ newLine: 2 });
        expect(lines?.[3]).toMatchObject({ oldLine: 3, newLine: 3 });
    });

    it("marks the span that changed when one line replaces one line", () => {
        const lines = diffLines("    background: var(--pane);\n", "    background: transparent;\n");
        const deleted = lines?.find((line) => line.sign === "-");
        const added = lines?.find((line) => line.sign === "+");
        expect(deleted?.text.slice(...(deleted?.mark ?? [0, 0]))).toBe("var(--pane)");
        expect(added?.text.slice(...(added?.mark ?? [0, 0]))).toBe("transparent");
    });

    it("leaves two unrelated lines unmarked rather than inventing a span", () => {
        const lines = diffLines("alpha\n", "beta\n");
        expect(lines?.every((line) => line.mark === undefined)).toBe(true);
    });

    it("reads an insertion as added lines, not as a rewrite", () => {
        const lines = diffLines("one\ntwo\n", "one\nextra\ntwo\n");
        expect(lines?.map((line) => `${line.sign}${line.text}`)).toEqual([" one", "+extra", " two"]);
    });

    it("gives up on a change too large to read in a transcript", () => {
        const big = Array.from({ length: 900 }, (_, index) => `line ${index}`).join("\n");
        expect(diffLines(big, `${big}\nmore`)).toBeNull();
    });
});

describe("toolDiff", () => {
    it("takes the change the adapter already computed", () => {
        const diff = toolDiff(
            tool({
                content: [
                    { type: "diff", path: "src/styles/stage.css", oldText: "background: var(--pane);\n", newText: "background: transparent;\n" },
                ],
            }),
        );
        expect(diff).toMatchObject({ path: "src/styles/stage.css", adds: 1, dels: 1 });
    });

    it("falls back to what the tool was asked to do", () => {
        const diff = toolDiff(tool({ rawInput: { file_path: "src/app.ts", old_string: "a\n", new_string: "a\nb\n" } }));
        expect(diff).toMatchObject({ path: "src/app.ts", adds: 1, dels: 0 });
    });

    it("reads a write of a new file as all additions", () => {
        const diff = toolDiff(tool({ rawInput: { file_path: "src/new.ts", content: "one\ntwo\n" } }));
        expect(diff).toMatchObject({ path: "src/new.ts", adds: 2, dels: 0 });
    });

    it("has nothing to show for a call that changed no file", () => {
        expect(toolDiff(tool({ rawInput: { command: "pnpm test" } }))).toBeNull();
        expect(toolDiff(tool({ rawInput: { file_path: "src/app.ts", old_string: "same\n", new_string: "same\n" } }))).toBeNull();
    });
});

describe("collapseDiff", () => {
    it("folds the unchanged stretches away and counts them", () => {
        const lines = diffLines(
            Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n"),
            [
                ...Array.from({ length: 10 }, (_, index) => `line ${index}`),
                "changed",
                ...Array.from({ length: 9 }, (_, index) => `line ${index + 11}`),
            ].join("\n"),
        );
        const view = collapseDiff(lines ?? [], 2);
        expect(view.hidden).toBe(15);
        expect(view.rows.filter((row) => "gap" in row)).toHaveLength(2);
        expect(view.rows.filter((row) => "sign" in row && row.sign !== " ")).toHaveLength(2);
    });

    it("keeps a short diff whole", () => {
        const view = collapseDiff(diffLines("a\nb\n", "a\nB\n") ?? [], 3);
        expect(view.hidden).toBe(0);
        expect(view.rows.every((row) => "sign" in row)).toBe(true);
    });
});

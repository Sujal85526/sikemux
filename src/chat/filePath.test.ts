import { describe, expect, it } from "vitest";
import { parsePathRef, scanPathCandidates } from "./filePath";

const roots = { cwd: "/work/demo", home: "/Users/pat" };

describe("parsePathRef", () => {
    it("resolves a path the agent wrote relative to the project", () => {
        expect(parsePathRef("src/chat/AgentChatPane.tsx", roots)).toEqual({
            path: "/work/demo/src/chat/AgentChatPane.tsx",
            line: undefined,
            column: undefined,
        });
    });

    it("keeps an absolute path as it is", () => {
        expect(parsePathRef("/etc/hosts", roots)?.path).toBe("/etc/hosts");
    });

    it("reads the line and column a reference names", () => {
        expect(parsePathRef("src/a.ts:42:7", roots)).toEqual({ path: "/work/demo/src/a.ts", line: 42, column: 7 });
        expect(parsePathRef("src/a.ts:42", roots)?.line).toBe(42);
    });

    it("reads the line a code host puts behind a hash", () => {
        expect(parsePathRef("file:///work/demo/src/a.ts#L9", roots)).toEqual({ path: "/work/demo/src/a.ts", line: 9, column: undefined });
    });

    it("decodes a file URI", () => {
        expect(parsePathRef("file:///work/demo/my%20notes.md", roots)?.path).toBe("/work/demo/my notes.md");
    });

    it("expands a path written from home", () => {
        expect(parsePathRef("~/notes/todo.md", roots)?.path).toBe("/Users/pat/notes/todo.md");
    });

    it("drops the leading dot of a path written as here", () => {
        expect(parsePathRef("./src/a.ts", roots)?.path).toBe("/work/demo/src/a.ts");
    });

    it("refuses a web address", () => {
        expect(parsePathRef("https://example.com/a/b.ts", roots)).toBeNull();
        expect(parsePathRef("mailto:pat@example.com", roots)).toBeNull();
    });

    it("refuses a bare word that names nothing", () => {
        expect(parsePathRef("finally", roots)).toBeNull();
        expect(parsePathRef("run the build", roots)).toBeNull();
    });

    it("takes a bare name that carries an extension", () => {
        expect(parsePathRef("package.json", roots)?.path).toBe("/work/demo/package.json");
        expect(parsePathRef("Makefile", roots)?.path).toBe("/work/demo/Makefile");
    });

    it("keeps a Windows path whole", () => {
        expect(parsePathRef("C:\\work\\demo\\a.ts", roots)?.path).toBe("C:/work/demo/a.ts");
    });
});

describe("scanPathCandidates", () => {
    it("finds a path in the middle of a sentence without its full stop", () => {
        expect(scanPathCandidates("I edited src/a.ts.")).toEqual([{ start: 9, end: 17, raw: "src/a.ts" }]);
    });

    it("unwraps a path a sentence put in brackets", () => {
        expect(scanPathCandidates("see (src/a.ts)")).toEqual([{ start: 5, end: 13, raw: "src/a.ts" }]);
    });

    it("keeps the line a reference names", () => {
        expect(scanPathCandidates("src/a.ts:42 fails")[0].raw).toBe("src/a.ts:42");
    });

    it("finds every path in a run of text", () => {
        expect(scanPathCandidates("moved src/a.ts to src/b.ts").map((found) => found.raw)).toEqual(["src/a.ts", "src/b.ts"]);
    });

    it("passes over ordinary words", () => {
        expect(scanPathCandidates("read it and/or write it, either way")).toEqual([{ start: 8, end: 14, raw: "and/or" }]);
        expect(scanPathCandidates("it either works or it does not")).toEqual([]);
    });

    it("passes over a web address", () => {
        expect(scanPathCandidates("see https://example.com/a/b for more")).toEqual([]);
    });
});

import { describe, expect, it } from "vitest";
import { basename, dirname, expandHome, prettyPath } from "./paths";

describe("path helpers", () => {
    it("extracts basenames for unix-style paths", () => {
        expect(basename("/tmp/project/file.ts")).toBe("file.ts");
        expect(basename("/tmp/project/")).toBe("project");
        expect(basename("file.ts")).toBe("file.ts");
        expect(basename("")).toBe("");
    });

    it("extracts dirnames without trailing slash noise", () => {
        expect(dirname("/tmp/project/file.ts")).toBe("/tmp/project");
        expect(dirname("/tmp/project/")).toBe("/tmp");
        expect(dirname("file.ts")).toBe("");
        expect(dirname("/")).toBe("");
    });

    it("pretty-prints and expands home paths", () => {
        expect(prettyPath("/Users/alice/proj", "/Users/alice")).toBe("~/proj");
        expect(prettyPath("/var/tmp", "/Users/alice")).toBe("/var/tmp");
        expect(expandHome("~", "/Users/alice")).toBe("/Users/alice");
        expect(expandHome("~/proj", "/Users/alice")).toBe("/Users/alice/proj");
        expect(expandHome("/tmp", "/Users/alice")).toBe("/tmp");
    });
});

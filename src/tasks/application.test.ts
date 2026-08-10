import { describe, expect, it } from "vitest";
import { projectTaskDefinitions } from "./application";

describe("project task application adapter", () => {
    it("resolves project-relative working directories and owns copied environment", () => {
        const env = { NODE_ENV: "test" };
        const definitions = projectTaskDefinitions("/repo", [
            { id: "root", label: "Root", command: "pnpm test", cwd: ".", env: {} },
            { id: "web", label: "Web", command: "pnpm dev", cwd: "packages/web", env },
        ]);

        expect(definitions).toEqual([
            { id: "root", label: "Root", command: "pnpm test", project: "/repo", cwd: "/repo", env: {} },
            { id: "web", label: "Web", command: "pnpm dev", project: "/repo", cwd: "/repo/packages/web", env: { NODE_ENV: "test" } },
        ]);
        expect(Object.isFrozen(definitions)).toBe(true);
        expect(Object.isFrozen(definitions[1])).toBe(true);
        expect(Object.isFrozen(definitions[1]!.env)).toBe(true);
        env.NODE_ENV = "production";
        expect(definitions[1]!.env).toEqual({ NODE_ENV: "test" });
    });
});

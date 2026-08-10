import { afterEach, describe, expect, it } from "vitest";
import {
    activeProjectTaskInventoryMatches,
    clearActiveProjectTasks,
    getAppTaskSnapshot,
    projectTaskDefinitions,
    replaceActiveProjectTasks,
    subscribeAppTasks,
} from "./application";

afterEach(() => clearActiveProjectTasks());

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

    it("hides same-root tasks until the registry matches the current config fingerprint", () => {
        const project = "/repo";
        replaceActiveProjectTasks(project, "config-a", [{ id: "check", label: "Old check", command: "pnpm check:a", cwd: ".", env: {} }]);

        expect(activeProjectTaskInventoryMatches(project, "config-a")).toBe(true);
        expect(getAppTaskSnapshot().tasks).toEqual([expect.objectContaining({ label: "Old check", command: "pnpm check:a" })]);

        // The controller has published config B, but App's passive registry
        // replacement effect has not run yet. Definitions from A stay gated.
        expect(activeProjectTaskInventoryMatches(project, "config-b")).toBe(false);
        const visibleForConfigB = activeProjectTaskInventoryMatches(project, "config-b") ? getAppTaskSnapshot().tasks : [];
        expect(visibleForConfigB).toEqual([]);

        const coherentNotifications: boolean[] = [];
        const unsubscribe = subscribeAppTasks(() => coherentNotifications.push(activeProjectTaskInventoryMatches(project, "config-b")));
        replaceActiveProjectTasks(project, "config-b", [{ id: "check", label: "New check", command: "pnpm check:b", cwd: ".", env: {} }]);

        expect(coherentNotifications).toEqual([true]);
        expect(getAppTaskSnapshot().tasks).toEqual([expect.objectContaining({ label: "New check", command: "pnpm check:b" })]);
        unsubscribe();
    });
});

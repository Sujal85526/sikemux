import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearProjectConfigTrustForTests, projectActionCommand, trustProjectConfig, worktreeHookCommand } from "./projectConfigRuntime";

beforeEach(clearProjectConfigTrustForTests);

describe("project config runtime boundary", () => {
    it("adapts actions and hooks without executing them", () => {
        expect(
            projectActionCommand({ id: "test", label: "Test", description: "Run tests", command: "pnpm test", placement: "popup", contexts: [] }),
        ).toEqual({ id: "project.test", title: "Test", detail: "Run tests", command: "pnpm test", placement: "popup", contexts: [] });
        expect(worktreeHookCommand({ id: "deps", label: "Install", command: "pnpm install" })).toMatchObject({
            id: "project.worktree.deps",
            placement: "background",
        });
    });

    it("asks once per exact fingerprint", () => {
        const confirm = vi.fn(() => true);
        const result = {
            status: "valid" as const,
            path: "/repo/sikemux.json",
            fingerprint: "sha256:one",
            config: { version: 1 as const, actions: [] },
            trust: { requiresApproval: true, executableEntries: 1, reasons: ["a project action"] },
        };
        expect(trustProjectConfig(result, confirm)).toBe(true);
        expect(trustProjectConfig(result, confirm)).toBe(true);
        expect(confirm).toHaveBeenCalledTimes(1);
    });

    it("does not remember rejected trust", () => {
        const confirm = vi.fn(() => false);
        const result = {
            status: "valid" as const,
            path: "/repo/sikemux.json",
            fingerprint: "sha256:two",
            config: { version: 1 as const, actions: [] },
            trust: { requiresApproval: true, executableEntries: 1, reasons: ["a hook"] },
        };
        expect(trustProjectConfig(result, confirm)).toBe(false);
        expect(trustProjectConfig(result, confirm)).toBe(false);
        expect(confirm).toHaveBeenCalledTimes(2);
    });

    it("scopes trust to both content and project path", () => {
        const confirm = vi.fn(() => true);
        const base = {
            status: "valid" as const,
            fingerprint: "sha256:same",
            config: { version: 1 as const, actions: [] },
            trust: { requiresApproval: true, executableEntries: 1, reasons: ["an action"] },
        };
        expect(trustProjectConfig({ ...base, path: "/repo-a/sikemux.json" }, confirm)).toBe(true);
        expect(trustProjectConfig({ ...base, path: "/repo-b/sikemux.json" }, confirm)).toBe(true);
        expect(confirm).toHaveBeenCalledTimes(2);
    });
});

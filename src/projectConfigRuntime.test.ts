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

    it("asks once per exact fingerprint", async () => {
        const confirm = vi.fn(async () => true);
        const result = {
            status: "valid" as const,
            path: "/repo/sikemux.json",
            fingerprint: "sha256:one",
            config: { version: 1 as const, actions: [], tasks: [] },
            trust: { requiresApproval: true, executableEntries: 1, reasons: ["a project action"] },
        };
        await expect(trustProjectConfig(result, confirm)).resolves.toBe(true);
        await expect(trustProjectConfig(result, confirm)).resolves.toBe(true);
        expect(confirm).toHaveBeenCalledTimes(1);
    });

    it("does not remember rejected trust", async () => {
        const confirm = vi.fn(async () => false);
        const result = {
            status: "valid" as const,
            path: "/repo/sikemux.json",
            fingerprint: "sha256:two",
            config: { version: 1 as const, actions: [], tasks: [] },
            trust: { requiresApproval: true, executableEntries: 1, reasons: ["a hook"] },
        };
        await expect(trustProjectConfig(result, confirm)).resolves.toBe(false);
        await expect(trustProjectConfig(result, confirm)).resolves.toBe(false);
        expect(confirm).toHaveBeenCalledTimes(2);
    });

    it("scopes trust to both content and project path", async () => {
        const confirm = vi.fn(async () => true);
        const base = {
            status: "valid" as const,
            fingerprint: "sha256:same",
            config: { version: 1 as const, actions: [], tasks: [] },
            trust: { requiresApproval: true, executableEntries: 1, reasons: ["an action"] },
        };
        await expect(trustProjectConfig({ ...base, path: "/repo-a/sikemux.json" }, confirm)).resolves.toBe(true);
        await expect(trustProjectConfig({ ...base, path: "/repo-b/sikemux.json" }, confirm)).resolves.toBe(true);
        expect(confirm).toHaveBeenCalledTimes(2);
    });
});

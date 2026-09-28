import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginStreamHandlers } from "../../plugin-api/backend";

const fake = vi.hoisted(() => ({
    call: vi.fn(),
    stream: vi.fn(),
    openStream: vi.fn(),
    closeStream: vi.fn(),
    invalidate: vi.fn(),
}));

vi.mock("../../plugin-api/backend", async (importOriginal) => ({
    ...(await importOriginal<object>()),
    createPluginBackend: () => fake,
}));
vi.mock("../../plugin-api/resources", () => ({ invalidate: fake.invalidate }));

import { actionsApi, type RunTick } from "./api";

const repo = { owner: "nodelike", name: "sikemux" };
const refused = { category: "auth", message: "github: sign-in failed: Bad credentials" };
const conflict = { category: "http", message: "github: http 409: the branch moved", status: 409 };

const clearedGithub = () =>
    fake.invalidate.mock.calls.some(
        ([matches]) => (matches as (kind: string) => boolean)("gha.pulls") && !(matches as (kind: string) => boolean)("other.kind"),
    );

beforeEach(() => {
    for (const mock of Object.values(fake)) mock.mockReset();
});

describe("a refused token", () => {
    it("clears what the GitHub views remember when a write finds out", async () => {
        fake.call.mockRejectedValue(refused);
        await expect(actionsApi.mergePull(repo, 1, "squash", "a".repeat(40))).rejects.toBe(refused);
        expect(clearedGithub()).toBe(true);
    });

    it("leaves it alone when a write fails for any other reason", async () => {
        fake.call.mockRejectedValue(conflict);
        await expect(actionsApi.addComment(repo, 1, "hi")).rejects.toBe(conflict);
        expect(fake.invalidate).not.toHaveBeenCalled();
    });

    it("clears it when a download is refused", async () => {
        fake.stream.mockImplementation((_method: string, _params: unknown, handlers: PluginStreamHandlers<unknown>) => {
            handlers.onError?.(refused);
            return { stop() {} };
        });
        await expect(actionsApi.downloadArtifact(repo, 3, "build")).rejects.toBe(refused);
        expect(clearedGithub()).toBe(true);
    });

    it("clears it when a watched run finds the account signed out", async () => {
        let onTick: (tick: RunTick) => void = () => {};
        fake.openStream.mockImplementation((_method: string, _params: unknown, deliver: (tick: RunTick) => void) => {
            onTick = deliver;
            return Promise.resolve(1);
        });
        const seen = vi.fn();
        await actionsApi.watchStart(repo, 7, seen);
        onTick({ run: null, jobs: [], error: "github: not signed in", finished: true, fatal: true, signedOut: true });
        expect(seen).toHaveBeenCalledTimes(1);
        expect(clearedGithub()).toBe(true);
    });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { filesApi, type ProjectFilesSnapshot } from "./files";

const { invokeCommand } = vi.hoisted(() => ({ invokeCommand: vi.fn() }));

vi.mock("./invoke", () => ({ invokeCommand }));

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

beforeEach(() => {
    invokeCommand.mockReset();
    filesApi.invalidate();
});

describe("filesApi snapshots", () => {
    it("deduplicates requests and preserves file identity for an unchanged scan", async () => {
        const firstFiles = ["a.ts"];
        invokeCommand.mockResolvedValueOnce({ scanId: 1, files: firstFiles });

        const [first, coalesced] = await Promise.all([filesApi.snapshot("/repo"), filesApi.snapshot("/repo")]);
        expect(coalesced).toBe(first);
        expect(invokeCommand).toHaveBeenCalledTimes(1);

        filesApi.invalidate("/repo");
        invokeCommand.mockResolvedValueOnce({ scanId: 1, files: ["unused.ts"] });
        const unchanged = await filesApi.snapshot("/repo");
        expect(unchanged.files).toBe(firstFiles);

        filesApi.invalidate("/repo");
        invokeCommand.mockResolvedValueOnce({ scanId: 2, files: ["a.ts", "b.ts"] });
        await expect(filesApi.list("/repo")).resolves.toEqual(["a.ts", "b.ts"]);
    });

    it("does not let an invalidated late response replace a newer snapshot", async () => {
        const oldRequest = deferred<ProjectFilesSnapshot>();
        const newRequest = deferred<ProjectFilesSnapshot>();
        invokeCommand.mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(newRequest.promise);

        const oldResult = filesApi.snapshot("/race");
        filesApi.invalidate("/race");
        const newResult = filesApi.snapshot("/race");
        newRequest.resolve({ scanId: 4, files: ["new.ts"] });
        await expect(newResult).resolves.toEqual({ scanId: 4, files: ["new.ts"] });

        oldRequest.resolve({ scanId: 3, files: ["old.ts"] });
        await expect(oldResult).resolves.toEqual({ scanId: 4, files: ["new.ts"] });
        await expect(filesApi.list("/race")).resolves.toEqual(["new.ts"]);
        expect(invokeCommand).toHaveBeenCalledTimes(2);
    });

    it("rejects malformed native snapshots without caching them", async () => {
        invokeCommand.mockResolvedValueOnce({ scanId: 0, files: ["bad.ts"] }).mockResolvedValueOnce({ scanId: 7, files: ["good.ts"] });
        await expect(filesApi.snapshot("/invalid")).rejects.toThrow("malformed");
        await expect(filesApi.list("/invalid")).resolves.toEqual(["good.ts"]);
        expect(invokeCommand).toHaveBeenCalledTimes(2);
    });
});

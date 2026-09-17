import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeCommand } = vi.hoisted(() => ({ invokeCommand: vi.fn() }));
vi.mock("./invoke", () => ({ invokeCommand }));

import { forgetMovingRevisions, git } from "./git";
import { emit } from "../state/bus";

beforeEach(() => {
    invokeCommand.mockReset();
    forgetMovingRevisions();
});

describe("git.fileAt", () => {
    it("serves HEAD from cache until the repository changes", async () => {
        invokeCommand.mockResolvedValue("first");
        expect(await git.fileAt("/repo", "HEAD", "a.ts")).toBe("first");
        expect(await git.fileAt("/repo", "HEAD", "a.ts")).toBe("first");
        expect(invokeCommand).toHaveBeenCalledTimes(1);

        invokeCommand.mockResolvedValue("second");
        emit({ type: "fs-changed", repo: "/repo" });
        expect(await git.fileAt("/repo", "HEAD", "a.ts")).toBe("second");
        expect(invokeCommand).toHaveBeenCalledTimes(2);
    });

    it("keeps commit reads across a repository change", async () => {
        invokeCommand.mockResolvedValue("pinned");
        expect(await git.fileAt("/repo", "abc1234", "a.ts")).toBe("pinned");
        emit({ type: "git-refresh", repo: "/repo" });
        expect(await git.fileAt("/repo", "abc1234", "a.ts")).toBe("pinned");
        expect(invokeCommand).toHaveBeenCalledTimes(1);
    });

    it("shares one read between callers that ask at the same time", async () => {
        invokeCommand.mockResolvedValue("shared");
        const [left, right] = await Promise.all([git.fileAt("/repo", "HEAD", "a.ts"), git.fileAt("/repo", "HEAD", "a.ts")]);
        expect([left, right]).toEqual(["shared", "shared"]);
        expect(invokeCommand).toHaveBeenCalledTimes(1);
    });

    it("drops the least recently used entry once the cache is full", async () => {
        for (let index = 0; index < 205; index++) {
            invokeCommand.mockResolvedValue(`body-${index}`);
            await git.fileAt("/repo", `abc123${index}`, "a.ts");
        }
        invokeCommand.mockClear();
        invokeCommand.mockResolvedValue("refetched");

        expect(await git.fileAt("/repo", "abc1230", "a.ts")).toBe("refetched");
        expect(invokeCommand).toHaveBeenCalledTimes(1);
        expect(await git.fileAt("/repo", "abc123204", "a.ts")).toBe("body-204");
        expect(invokeCommand).toHaveBeenCalledTimes(1);
    });
});

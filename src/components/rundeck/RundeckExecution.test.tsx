import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { watchStart, watchStop, logsStart, logsStop } = vi.hoisted(() => ({
    watchStart: vi.fn(),
    watchStop: vi.fn(() => Promise.resolve()),
    logsStart: vi.fn(),
    logsStop: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../api/rundeck", () => ({
    rundeckApi: { watchStart, watchStop, logsStart, logsStop, abort: vi.fn() },
}));
vi.mock("../VirtualLogList", () => ({ VirtualLogList: () => null }));

import { RundeckExecution } from "./RundeckExecution";

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
        resolve = res;
    });
    return { promise, resolve };
}

describe("RundeckExecution", () => {
    it("stops subscriptions whose ids arrive after unmount", async () => {
        const watch = deferred<number>();
        const logs = deferred<number>();
        watchStart.mockReset().mockReturnValue(watch.promise);
        logsStart.mockReset().mockReturnValue(logs.promise);
        watchStop.mockClear();
        logsStop.mockClear();

        const { unmount } = render(
            <RundeckExecution paneId="pane" active level={{ kind: "execution", executionId: 42, project: "ops", service: "api" }} />,
        );
        unmount();
        await act(async () => {
            watch.resolve(7);
            logs.resolve(8);
        });

        expect(watchStop).toHaveBeenCalledWith(7);
        expect(logsStop).toHaveBeenCalledWith(8);
    });
});

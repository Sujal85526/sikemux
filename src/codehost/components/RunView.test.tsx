import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Run, RunTick } from "../api";

const api = vi.hoisted(() => ({
    run: vi.fn(),
    runAttempt: vi.fn(),
    pendingApprovals: vi.fn(() => Promise.resolve([])),
    runTiming: vi.fn(() => new Promise(() => {})),
    artifacts: vi.fn(() => Promise.resolve([])),
    watchStart: vi.fn(),
    watchStop: vi.fn(() => Promise.resolve()),
    rerun: vi.fn(() => Promise.resolve()),
    cancel: vi.fn(() => Promise.resolve()),
}));

import { invalidate } from "../../plugin-api/resources";
import { RunMenu } from "./RunMenu";
import { RunView } from "./RunView";
import { InHost, registerTestHost, TEST_HOST } from "../testHost";

const host = registerTestHost(api);
const wrapper = ({ children }: { children: React.ReactNode }) => <InHost host={host}>{children}</InHost>;

const repo = { provider: TEST_HOST, owner: "nodelike", name: "sikemux" };

const makeRun = (overrides: Partial<Run> = {}): Run => ({
    id: "7",
    name: "CI",
    title: "Ship it",
    workflowId: "1",
    path: null,
    runNumber: 12,
    attempt: 1,
    event: "push",
    status: "completed",
    conclusion: "failure",
    branch: "main",
    sha: "abc123",
    shortSha: "abc123",
    actor: null,
    avatarUrl: null,
    createdAt: "2026-01-01T12:00:00Z",
    startedAt: "2026-01-01T12:00:00Z",
    updatedAt: "2026-01-01T12:05:00Z",
    pullRequests: [],
    url: "https://github.com/nodelike/sikemux/actions/runs/7",
    ...overrides,
});

const waiting = makeRun({ status: "waiting", conclusion: null });

function setHidden(hidden: boolean) {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
    invalidate(() => true);
    for (const mock of Object.values(api)) mock.mockClear();
    api.watchStart.mockReset().mockResolvedValue(1);
    api.runAttempt
        .mockReset()
        .mockImplementation((_repo, runId: string, attempt: number) => Promise.resolve({ run: makeRun({ id: runId, attempt }), jobs: [] }));
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
});

async function renderRun(run: Run, runId = run.id) {
    api.run.mockReset().mockImplementation((_repo, id: string) => Promise.resolve({ run: { ...run, id }, jobs: [] }));
    const view = render(<RunView paneId="pane" repo={repo} runId={runId} openJob={null} active canWrite />, { wrapper });
    await act(async () => {});
    return view;
}

describe("a run waiting for approval", () => {
    it("offers to cancel it and nothing that only a finished run allows", async () => {
        await renderRun(waiting);
        expect(screen.getByRole("button", { name: "Cancel run" })).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Re-run all jobs" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Re-run failed jobs" })).toBeNull();
    });

    it("keeps its menu to the actions that do not need it to be over", () => {
        render(<RunMenu run={waiting} repo={repo} canWrite onDeleted={() => {}} />, { wrapper });
        fireEvent.click(screen.getByRole("button", { name: "More run actions" }));
        expect(screen.getByRole("menuitem", { name: "Copy link" })).toBeTruthy();
        expect(screen.queryByRole("menuitem", { name: "Re-run all with debug logs" })).toBeNull();
        expect(screen.queryByRole("menuitem", { name: "Delete all logs" })).toBeNull();
        expect(screen.queryByRole("menuitem", { name: "Delete run" })).toBeNull();
    });

    it("is watched live", async () => {
        await renderRun(waiting);
        expect(api.watchStart).toHaveBeenCalledTimes(1);
    });
});

describe("RunView", () => {
    it("re-runs once however many times the button is pressed", async () => {
        await renderRun(makeRun());
        const button = screen.getByRole("button", { name: "Re-run all jobs" });
        fireEvent.click(button);
        fireEvent.click(button);
        await act(async () => {});
        expect(api.rerun).toHaveBeenCalledTimes(1);
    });

    it("asks a newly opened run for its latest attempt, not the attempt picked on the one before", async () => {
        const view = await renderRun(makeRun({ attempt: 2 }));
        fireEvent.click(screen.getByRole("button", { name: "#1" }));
        await act(async () => {});
        expect(api.runAttempt).toHaveBeenCalledWith(repo, "7", 1);
        api.runAttempt.mockClear();

        view.rerender(<RunView paneId="pane" repo={repo} runId="8" openJob={null} active canWrite />);
        await act(async () => {});
        expect(api.runAttempt).not.toHaveBeenCalled();
        expect(api.run).toHaveBeenCalledWith(repo, "8");
    });

    it("starts the watch again, and says why, when it gives up on a run still going", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        await renderRun(makeRun({ status: "in_progress", conclusion: null }));
        const onTick = api.watchStart.mock.calls[0][2] as (tick: RunTick) => void;
        act(() => onTick({ run: null, jobs: [], error: "GitHub is rate limiting this token", finished: true, fatal: false, signedOut: false }));
        expect(screen.getByText("GitHub is rate limiting this token")).toBeTruthy();
        await act(async () => {
            vi.advanceTimersByTime(60_000);
        });
        expect(api.watchStart).toHaveBeenCalledTimes(2);
    });

    it("stops for good, still saying why, when watching again cannot help", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        await renderRun(makeRun({ status: "in_progress", conclusion: null }));
        const onTick = api.watchStart.mock.calls[0][2] as (tick: RunTick) => void;
        act(() => onTick({ run: null, jobs: [], error: "github: not signed in", finished: true, fatal: true, signedOut: true }));
        expect(screen.getByText("github: not signed in")).toBeTruthy();
        await act(async () => {
            vi.advanceTimersByTime(10 * 60_000);
        });
        await act(async () => setHidden(true));
        await act(async () => setHidden(false));
        expect(api.watchStart).toHaveBeenCalledTimes(1);
    });

    it("stops watching while the window is hidden and picks up again when it is shown", async () => {
        await renderRun(makeRun({ status: "in_progress", conclusion: null }));
        expect(api.watchStart).toHaveBeenCalledTimes(1);
        await act(async () => setHidden(true));
        expect(api.watchStop).toHaveBeenCalledWith(1);
        await act(async () => setHidden(false));
        expect(api.watchStart).toHaveBeenCalledTimes(2);
    });
});

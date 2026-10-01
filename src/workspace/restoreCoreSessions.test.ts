import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import type { CoreSession } from "../api/coreSessions";
import * as cmd from "../state/commands";
import { getState, setState } from "../state/store";
import { useToasts } from "../state/toast";
import { agentWindowId } from "../state/selectors";
import { withAgents } from "../test/agents";
import { isResumableSession, takeResumableSession } from "../terminal/sessionResume";
import { KEPT_RUNNING_NOTICE, UNCLAIMED_GRACE_MS, offerSavedSessions, restoreCoreSessions, type CoreSessionRestoreDeps } from "./restoreCoreSessions";

const initial = getState();

function terminal(id: number, running = true): CoreSession {
    return { id, kind: "terminal", pid: 1, running, project: null, paneId: null, agentId: null, agentType: null, task: null, exit: null };
}

function deps(sessions: CoreSession[]) {
    const scheduled: Array<() => void> = [];
    const kill = vi.fn(async (_id: number) => {});
    const restore: CoreSessionRestoreDeps = {
        list: async () => sessions,
        kill,
        tasks: { watch: vi.fn(), adoptDeckTask: vi.fn(), adoptHarnessRun: vi.fn() },
        schedule: (callback, delay) => {
            expect(delay).toBe(UNCLAIMED_GRACE_MS);
            scheduled.push(callback);
        },
    };
    return { restore, kill, runScheduled: () => scheduled.splice(0).forEach((callback) => callback()) };
}

function layoutWithSessions() {
    const sid = getState().activeSessionId;
    const paneId = getState().windows[getState().sessions[sid].activeWindowId].activePaneId;
    cmd.setPanePty(paneId, 101);
    setState((s) => {
        const slices = withAgents(s, sid, [
            { id: "agent-live", type: "pi", title: "live", startup: "pi", ptyId: 102, launchState: "dormant" },
            { id: "agent-ended", type: "claude", title: "ended", startup: "claude", resumeId: "r1", ptyId: 103, launchState: "dormant" },
        ]);
        return { ...slices, sessions: { ...s.sessions, [sid]: { ...s.sessions[sid], kind: "project" } } };
    });
    return { sid, paneId };
}

beforeEach(() => {
    setState(initial, true);
    useToasts.setState({ toasts: [] });
});

describe("restoring what the core kept", () => {
    it("lets each saved terminal be taken back once", () => {
        layoutWithSessions();
        offerSavedSessions();
        expect(isResumableSession(101)).toBe(true);
        expect(takeResumableSession(102)).toBe(true);
        expect(takeResumableSession(102)).toBe(false);
        expect(isResumableSession(999)).toBe(false);
        takeResumableSession(101);
        takeResumableSession(103);
    });

    it("wakes agents whose terminal runs, lets the others sleep, and stops only unclaimed terminals after the grace", async () => {
        const { sid } = layoutWithSessions();
        const { restore, kill, runScheduled } = deps([terminal(101), terminal(102), terminal(103, false), terminal(104), terminal(105)]);

        await restoreCoreSessions(restore);

        expect(getState().agents["agent-live"]).toMatchObject({ launchState: "live", ptyId: 102 });
        expect(getState().agents["agent-ended"].launchState).toBe("dormant");
        expect(getState().agents["agent-ended"].ptyId).toBeUndefined();
        expect(agentWindowId(getState(), "agent-ended")).toBeTruthy();
        expect(kill).not.toHaveBeenCalled();

        cmd.newWindow();
        cmd.setPanePty(getState().windows[getState().sessions[sid].activeWindowId].activePaneId, 104);
        runScheduled();
        expect(kill.mock.calls.map(([id]) => id).sort()).toEqual([103, 105]);
    });

    it("closes a terminal agent with nothing to resume once its terminal is gone", async () => {
        const sid = getState().activeSessionId;
        setState((s) => {
            const slices = withAgents(s, sid, [{ id: "agent-gone", type: "pi", title: "gone", startup: "pi", ptyId: 7 }]);
            return { ...slices, sessions: { ...s.sessions, [sid]: { ...s.sessions[sid], kind: "project" } } };
        });
        await restoreCoreSessions(deps([]).restore);
        expect(getState().agents["agent-gone"]).toBeUndefined();
    });

    it("says once that terminals kept running", async () => {
        layoutWithSessions();
        await restoreCoreSessions(deps([terminal(101)]).restore);
        expect(useToasts.getState().toasts.map((toast) => toast.text)).toEqual([KEPT_RUNNING_NOTICE]);
        expect(getState().keptRunningNoticeShown).toBe(true);

        useToasts.setState({ toasts: [] });
        await restoreCoreSessions(deps([terminal(101)]).restore);
        expect(useToasts.getState().toasts).toEqual([]);
    });

    it("says nothing when nothing came back", async () => {
        layoutWithSessions();
        await restoreCoreSessions(deps([terminal(104)]).restore);
        expect(useToasts.getState().toasts).toEqual([]);
        expect(getState().keptRunningNoticeShown).toBe(false);
    });
});

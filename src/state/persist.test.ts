import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { applyHydrate, flushPersist, resetPersistenceForTests, subscribePersist } from "./persist";
import { getState, setState } from "./store";
import { useToasts } from "./toast";

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

const initial = getState();

beforeEach(() => {
    vi.useRealTimers();
    invoke.mockReset();
    resetPersistenceForTests();
    setState(initial, true);
    useToasts.setState({ toasts: [] });
});

describe("frontend persistence", () => {
    it("omits Bruno secrets and drafts while preserving non-secret Bruno and Rundeck state", async () => {
        const sid = getState().activeSessionId;
        setState((s) => ({
            sessions: {
                ...s.sessions,
                [sid]: {
                    ...s.sessions[sid],
                    kind: "bruno",
                    bruno: {
                        collectionPath: "/collections/demo",
                        selectedEnvs: { "/collections/demo": "staging" },
                        secretVars: { token: "do-not-persist" },
                        drafts: { "/collections/demo/login.bru": "Authorization: Bearer do-not-persist" },
                    },
                },
            },
            rundeck: { activeProject: "ops", activeEnvFolder: "prod", prodEnvs: ["prod"] },
        }));
        invoke.mockResolvedValue(undefined);

        expect(await flushPersist()).toBe(true);
        const raw = invoke.mock.calls[0][1].data as string;
        expect(raw).not.toContain("do-not-persist");
        const saved = JSON.parse(raw);
        expect(saved.sessions[0].bruno).toEqual({
            collectionPath: "/collections/demo",
            selectedEnvs: { "/collections/demo": "staging" },
        });
        expect(saved.prefs.rundeck).toEqual({ activeProject: "ops", activeEnvFolder: "prod", prodEnvs: ["prod"] });
    });

    it("serializes writes, coalesces queued snapshots, and marks only successful writes saved", async () => {
        const first = deferred<void>();
        invoke.mockImplementationOnce(() => first.promise).mockResolvedValue(undefined);

        setState({ themeId: "first" });
        const firstFlush = flushPersist();
        await Promise.resolve();
        expect(invoke).toHaveBeenCalledTimes(1);

        setState({ themeId: "latest" });
        const secondFlush = flushPersist();
        await Promise.resolve();
        expect(invoke).toHaveBeenCalledTimes(1);

        first.resolve();
        await expect(firstFlush).resolves.toBe(true);
        await expect(secondFlush).resolves.toBe(true);
        expect(invoke).toHaveBeenCalledTimes(2);
        expect(JSON.parse(invoke.mock.calls[1][1].data).prefs.themeId).toBe("latest");
    });

    it("drops an obsolete queued snapshot when state returns to the active write", async () => {
        const first = deferred<void>();
        invoke.mockImplementationOnce(() => first.promise).mockResolvedValue(undefined);

        setState({ themeId: "active" });
        const activeFlush = flushPersist();
        await Promise.resolve();
        setState({ themeId: "obsolete" });
        void flushPersist();
        setState({ themeId: "active" });
        void flushPersist();

        first.resolve();
        await expect(activeFlush).resolves.toBe(true);
        expect(invoke).toHaveBeenCalledTimes(1);
    });

    it("surfaces failed saves and retries the unsaved snapshot", async () => {
        vi.useFakeTimers();
        invoke.mockRejectedValueOnce(new Error("disk full")).mockResolvedValue(undefined);
        setState({ themeId: "retry-me" });

        await expect(flushPersist()).resolves.toBe(false);
        expect(useToasts.getState().toasts.at(-1)?.text).toContain("disk full");
        await vi.advanceTimersByTimeAsync(1600);
        expect(invoke).toHaveBeenCalledTimes(2);
        expect(JSON.parse(invoke.mock.calls[1][1].data).prefs.themeId).toBe("retry-me");
    });

    it("hydrates supported old snapshots safely, scrubs legacy Bruno credentials, and ignores malformed records", () => {
        const sid = getState().activeSessionId;
        const current = getState().sessions[sid];
        applyHydrate(
            JSON.stringify({
                version: 3,
                sessions: [
                    {
                        ...current,
                        kind: "bruno",
                        bruno: {
                            collectionPath: "/legacy",
                            selectedEnvs: { "/legacy": "dev" },
                            secretVars: { password: "legacy-secret" },
                            drafts: { "/legacy/a.bru": "legacy-secret" },
                        },
                    },
                    null,
                    { id: 42 },
                ],
                windowsBySession: { [sid]: [] },
                agentsBySession: {},
                sessionOrder: [sid, 42],
                activeSessionId: sid,
                recent: "bad",
                agentBookmarks: null,
                prefs: { rundeck: { activeProject: 7, prodEnvs: ["prod", 9] } },
                editorViews: { bad: { openTabs: "bad" } },
            }),
        );

        expect(getState().sessions[sid].bruno).toEqual({
            collectionPath: "/legacy",
            selectedEnvs: { "/legacy": "dev" },
            secretVars: {},
            drafts: {},
        });
        expect(getState().sessionOrder).toEqual([sid]);
        expect(getState().recent).toEqual([]);
        expect(getState().rundeck.activeProject).toBe("");
        expect(getState().rundeck.prodEnvs).toEqual(["prod"]);

        invoke.mockResolvedValue(undefined);
        const unsubscribe = subscribePersist();
        unsubscribe();
        expect(invoke).toHaveBeenCalledTimes(1);
        const migrated = invoke.mock.calls[0][1].data as string;
        expect(migrated).not.toContain("legacy-secret");
        expect(JSON.parse(migrated).version).toBe(4);
    });

    it("upgrades saved SSH terminals to the reconnecting startup command", () => {
        const sid = getState().activeSessionId;
        const session = getState().sessions[sid];
        const window = getState().windows[session.activeWindowId];

        applyHydrate(
            JSON.stringify({
                version: 4,
                sessions: [{ ...session, kind: "ssh", name: "prod-db" }],
                windowsBySession: {
                    [sid]: [
                        {
                            ...window,
                            root: { ...window.root, startup: "ssh prod-db" },
                        },
                    ],
                },
                agentsBySession: {},
                sessionOrder: [sid],
                activeSessionId: sid,
                prefs: {},
            }),
        );

        const restored = getState().windows[session.activeWindowId].root;
        expect(restored.type).toBe("pane");
        if (restored.type === "pane") {
            expect(restored.startup).toContain("Retrying (%s/5)");
        }
    });
});

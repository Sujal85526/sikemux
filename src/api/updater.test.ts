import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getState, setState, type PendingUpdate } from "../state/store";
import { MemoryIpcTransport, installIpcTransportForTests, resetIpcTransportForTests } from "./transport";
import { checkForUpdate, installPendingUpdate, isUpdateBusy, parseUpdateInstallProgress, updateDownloadPercent, updateStatusLabel } from "./updater";

const mocks = vi.hoisted(() => ({ relaunch: vi.fn(() => Promise.resolve()) }));

vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: mocks.relaunch }));
vi.mock("@tauri-apps/api/core", () => {
    class TestChannel<T> {
        onmessage: (message: T) => void = () => undefined;
    }
    return { Channel: TestChannel };
});

const initial = getState();
let transport: MemoryIpcTransport;

function availableUpdate(overrides: Partial<PendingUpdate> = {}): PendingUpdate {
    return {
        version: "0.2.1",
        currentVersion: "0.2.0",
        notes: "Fix updater progress",
        date: "2026-08-14T00:00:00Z",
        state: "available",
        error: null,
        downloadedBytes: 0,
        totalBytes: null,
        ...overrides,
    };
}

beforeEach(() => {
    resetIpcTransportForTests();
    transport = new MemoryIpcTransport();
    installIpcTransportForTests(transport);
    setState(initial, true);
    mocks.relaunch.mockClear();
});

afterEach(() => {
    resetIpcTransportForTests();
    setState(initial, true);
});

describe("updater progress", () => {
    it("validates progress payloads and clamps percentages", () => {
        expect(parseUpdateInstallProgress({ phase: "downloading", downloadedBytes: 50, totalBytes: 100 })).toEqual({
            phase: "downloading",
            downloadedBytes: 50,
            totalBytes: 100,
        });
        expect(parseUpdateInstallProgress({ phase: "other", downloadedBytes: 0, totalBytes: null })).toBeNull();
        expect(parseUpdateInstallProgress({ phase: "downloading", downloadedBytes: -1, totalBytes: null })).toBeNull();
        expect(updateDownloadPercent(availableUpdate({ downloadedBytes: 51, totalBytes: 100 }))).toBe(51);
        expect(updateDownloadPercent(availableUpdate({ downloadedBytes: 110, totalBytes: 100 }))).toBe(100);
        expect(updateDownloadPercent(availableUpdate())).toBeNull();
    });

    it("labels every update phase accurately", () => {
        expect(updateStatusLabel(availableUpdate())).toBe("Update · v0.2.1");
        expect(updateStatusLabel(availableUpdate({ state: "preparing" }))).toBe("Preparing update…");
        expect(updateStatusLabel(availableUpdate({ state: "downloading", downloadedBytes: 25, totalBytes: 100 }))).toBe("Downloading · 25%");
        expect(updateStatusLabel(availableUpdate({ state: "installing" }))).toBe("Verifying & installing…");
        expect(updateStatusLabel(availableUpdate({ state: "restarting" }))).toBe("Restarting…");
        expect(updateStatusLabel(availableUpdate({ state: "error" }))).toBe("Update failed — retry");
        expect(isUpdateBusy("downloading")).toBe(true);
        expect(isUpdateBusy("available")).toBe(false);
    });

    it("does not let polling erase an active installation", async () => {
        setState({ pendingUpdate: availableUpdate({ state: "downloading", downloadedBytes: 25, totalBytes: 100 }) });

        await checkForUpdate();

        expect(getState().pendingUpdate).toMatchObject({ state: "downloading", downloadedBytes: 25 });
    });

    it("discards a stale polling response that returns after installation starts", async () => {
        let resolveCheck!: (value: unknown) => void;
        const response = new Promise<unknown>((resolve) => {
            resolveCheck = resolve;
        });
        transport.register("update_check", () => response);
        setState({ pendingUpdate: availableUpdate() });

        const checking = checkForUpdate();
        setState({ pendingUpdate: availableUpdate({ state: "downloading", downloadedBytes: 25, totalBytes: 100 }) });
        resolveCheck({
            version: "0.2.2",
            currentVersion: "0.2.0",
            notes: "stale response",
            date: null,
        });
        await checking;

        expect(getState().pendingUpdate).toMatchObject({
            version: "0.2.1",
            state: "downloading",
            downloadedBytes: 25,
        });
    });

    it("streams download progress, separates installation, and relaunches", async () => {
        setState({ pendingUpdate: availableUpdate() });
        const installHandler = vi.fn(async (args: unknown) => {
            const { onProgress } = args as { onProgress: { onmessage: (message: unknown) => void } };
            onProgress.onmessage({ phase: "downloading", downloadedBytes: 25, totalBytes: 100 });
            expect(getState().pendingUpdate).toMatchObject({ state: "downloading", downloadedBytes: 25, totalBytes: 100 });
            onProgress.onmessage({ phase: "installing", downloadedBytes: 100, totalBytes: 100 });
            expect(getState().pendingUpdate).toMatchObject({ state: "installing", downloadedBytes: 100 });
            onProgress.onmessage({ phase: "installed", downloadedBytes: 100, totalBytes: 100 });
            return {
                version: "0.2.1",
                currentVersion: "0.2.0",
                notes: "Fix updater progress",
                date: "2026-08-14T00:00:00Z",
            };
        });
        transport.register("update_install", installHandler);

        await installPendingUpdate();

        expect(installHandler).toHaveBeenCalledOnce();
        expect(mocks.relaunch).toHaveBeenCalledOnce();
        expect(getState().pendingUpdate).toMatchObject({ state: "restarting", downloadedBytes: 100, totalBytes: 100 });
        expect(getState().lastReleaseNotes).toEqual({
            version: "0.2.1",
            notes: "Fix updater progress",
            date: "2026-08-14T00:00:00Z",
        });
    });

    it("deduplicates concurrent installs and exposes native failure for retry", async () => {
        setState({ pendingUpdate: availableUpdate() });
        const installHandler = vi.fn(async () => {
            throw new Error("download timed out");
        });
        transport.register("update_install", installHandler);

        const first = installPendingUpdate();
        const second = installPendingUpdate();
        expect(second).toBe(first);
        await first;

        expect(installHandler).toHaveBeenCalledOnce();
        expect(mocks.relaunch).not.toHaveBeenCalled();
        expect(getState().pendingUpdate).toMatchObject({ state: "error", error: "Error: download timed out" });
    });
});

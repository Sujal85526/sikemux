import { afterEach, describe, expect, it, vi } from "vitest";
import { performanceTelemetry } from "../lib/performance";
import {
    applyPtyShellMetadataEvent,
    parsePtyShellMetadataEvent,
    PTY_SHELL_METADATA_EVENT,
    resetPtyShellSubscriptionsForTests,
    subscribePtyShellMetadata,
} from "./ptyShell";

const mocks = vi.hoisted(() => ({
    handler: null as ((event: { payload: unknown }) => void) | null,
    unlisten: vi.fn(),
    listen: vi.fn(async (_name: string, handler: (event: { payload: unknown }) => void) => {
        mocks.handler = handler;
        return mocks.unlisten;
    }),
}));

vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));

afterEach(async () => {
    await resetPtyShellSubscriptionsForTests();
    performanceTelemetry.reset();
    mocks.handler = null;
    mocks.listen.mockClear();
    mocks.unlisten.mockClear();
});

const event = (overrides: Record<string, unknown> = {}) => ({
    ptyId: 42,
    revision: 1,
    boundary: "prompt_start",
    cwd: "/repo",
    phase: "prompt",
    ...overrides,
});

describe("PTY shell metadata adapter", () => {
    it("strictly parses bounded display-only events", () => {
        expect(parsePtyShellMetadataEvent(event())).toEqual({
            ptyId: 42,
            revision: 1,
            boundary: "prompt_start",
            cwd: "/repo",
            phase: "prompt",
            exitCode: null,
        });
        expect(parsePtyShellMetadataEvent(event({ boundary: "command_finished", phase: "finished", exitCode: 7 }))).toMatchObject({
            exitCode: 7,
        });
        expect(parsePtyShellMetadataEvent(event({ cwd: "/repo\nforged" }))).toBeNull();
        expect(parsePtyShellMetadataEvent(event({ boundary: "command_start", exitCode: 0 }))).toBeNull();
        expect(parsePtyShellMetadataEvent({ ...event(), extra: "nope" })).toBeNull();
    });

    it("merges monotonic events and preserves the last exit status", () => {
        const prompt = parsePtyShellMetadataEvent(event())!;
        const first = applyPtyShellMetadataEvent(null, prompt);
        const finished = parsePtyShellMetadataEvent(event({ revision: 2, boundary: "command_finished", phase: "finished", exitCode: 3 }))!;
        const second = applyPtyShellMetadataEvent(first, finished);
        const running = parsePtyShellMetadataEvent(event({ revision: 3, boundary: "command_start", phase: "running" }))!;

        expect(second.lastExitCode).toBe(3);
        expect(applyPtyShellMetadataEvent(second, running).lastExitCode).toBe(3);
        expect(applyPtyShellMetadataEvent(second, prompt)).toBe(second);
    });

    it("shares one native listener, routes by PTY, and tears down at zero subscribers", async () => {
        const first = vi.fn();
        const second = vi.fn();
        const unsubscribeFirst = await subscribePtyShellMetadata(42, first);
        const unsubscribeSecond = await subscribePtyShellMetadata(7, second);

        expect(mocks.listen).toHaveBeenCalledOnce();
        expect(mocks.listen).toHaveBeenCalledWith(PTY_SHELL_METADATA_EVENT, expect.any(Function));
        mocks.handler?.({ payload: event() });
        expect(first).toHaveBeenCalledOnce();
        expect(second).not.toHaveBeenCalled();

        unsubscribeFirst();
        expect(mocks.unlisten).not.toHaveBeenCalled();
        unsubscribeSecond();
        expect(mocks.unlisten).toHaveBeenCalledOnce();
    });

    it("contains invalid payloads and listener failures", async () => {
        const unsubscribe = await subscribePtyShellMetadata(42, () => {
            throw new Error("consumer failed");
        });
        mocks.handler?.({ payload: event({ cwd: "bad\0path" }) });
        mocks.handler?.({ payload: event() });

        expect(performanceTelemetry.snapshot().counters).toMatchObject({
            "terminal.shell-metadata.invalid-events": 1,
            "terminal.shell-metadata.listener-errors": 1,
        });
        unsubscribe();
    });
});

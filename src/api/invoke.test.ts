import type { InvokeArgs, InvokeOptions } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { performanceTelemetry } from "../lib/performance";
import {
    IPC_INVOKE_ACTIVE_GAUGE,
    IPC_INVOKE_CANCEL_COUNTER,
    IPC_INVOKE_ERROR_COUNTER,
    IPC_INVOKE_METRIC,
    IPC_INVOKE_SUCCESS_COUNTER,
    invokeCommand,
} from "./invoke";

const { rawInvoke } = vi.hoisted(() => ({ rawInvoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: rawInvoke }));

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

beforeEach(() => {
    rawInvoke.mockReset();
    performanceTelemetry.reset();
});

describe("invokeCommand", () => {
    it("tracks deterministic concurrent success and categorized error outcomes", async () => {
        const success = deferred<{ readonly marker: "result" }>();
        const failure = deferred<never>();
        rawInvoke.mockImplementationOnce(() => success.promise).mockImplementationOnce(() => failure.promise);

        const successful = invokeCommand<{ readonly marker: "result" }>("project_read", { path: "/project/file" });
        const failed = invokeCommand<never>("git_status", { repo: "/project" });

        expect(performanceTelemetry.snapshot().gauges[IPC_INVOKE_ACTIVE_GAUGE]).toBe(2);

        const result = { marker: "result" } as const;
        success.resolve(result);
        await expect(successful).resolves.toBe(result);
        expect(performanceTelemetry.snapshot()).toMatchObject({
            counters: { [IPC_INVOKE_SUCCESS_COUNTER]: 1 },
            gauges: { [IPC_INVOKE_ACTIVE_GAUGE]: 1 },
        });

        const nativeError = { category: "git", message: "sensitive native detail", payload: { secret: true } };
        failure.reject(nativeError);
        await expect(failed).rejects.toBe(nativeError);

        const snapshot = performanceTelemetry.snapshot();
        expect(snapshot).toMatchObject({
            counters: { [IPC_INVOKE_SUCCESS_COUNTER]: 1, [IPC_INVOKE_ERROR_COUNTER]: 1 },
            gauges: { [IPC_INVOKE_ACTIVE_GAUGE]: 0 },
            latencies: { [IPC_INVOKE_METRIC]: { count: 2, totalCount: 2 } },
        });
        const spans = snapshot.spans.filter((span) => span.name === IPC_INVOKE_METRIC);
        expect(spans).toHaveLength(2);
        expect(spans.map((span) => span.metadata.command)).toEqual(["project_read", "git_status"]);
        const requestIds = spans.map((span) => span.metadata.requestId as number);
        expect(requestIds[1]).toBe(requestIds[0] + 1);
        expect(spans[1].metadata).toMatchObject({ outcome: "error", category: "git" });
        expect(JSON.stringify(snapshot)).not.toContain("sensitive native detail");
        expect(JSON.stringify(snapshot)).not.toContain("secret");
    });

    it("passes opaque Channel-containing args and transport options through by identity", async () => {
        let payloadReads = 0;
        const channel = Object.freeze({ opaqueChannel: true });
        const args = Object.defineProperties(
            {},
            {
                channel: { enumerable: true, value: channel },
                privatePayload: {
                    enumerable: true,
                    get: () => {
                        payloadReads += 1;
                        throw new Error("adapter inspected args");
                    },
                },
            },
        ) as InvokeArgs;
        const invokeOptions: InvokeOptions = { headers: { "x-test": "opaque" } };
        const result = Object.defineProperty({}, "privateResult", {
            enumerable: true,
            get: () => {
                throw new Error("adapter inspected result");
            },
        });
        rawInvoke.mockImplementation((_command, receivedArgs, receivedOptions) => {
            expect(receivedArgs).toBe(args);
            expect(receivedOptions).toBe(invokeOptions);
            expect((receivedArgs as Record<string, unknown>).channel).toBe(channel);
            return Promise.resolve(result);
        });

        await expect(invokeCommand("pty_attach", args, { invokeOptions })).resolves.toBe(result);

        expect(payloadReads).toBe(0);
        const encodedTelemetry = JSON.stringify(performanceTelemetry.snapshot());
        expect(encodedTelemetry).not.toContain("privatePayload");
        expect(encodedTelemetry).not.toContain("privateResult");
        expect(encodedTelemetry).not.toContain("opaqueChannel");
    });

    it("preserves cancellation reasons and observes late transport settlement", async () => {
        const pending = deferred<{ secretResult: string }>();
        const controller = new AbortController();
        const args = { channel: Object.freeze({ id: 7 }) };
        rawInvoke.mockReturnValue(pending.promise);
        const invocation = invokeCommand("logs_tail", args, { signal: controller.signal });
        const reason = Object.freeze({ privateCancellationReason: true });

        controller.abort(reason);
        await expect(invocation).rejects.toBe(reason);

        expect(rawInvoke.mock.calls[0][1]).toBe(args);
        expect(performanceTelemetry.snapshot()).toMatchObject({
            counters: { [IPC_INVOKE_CANCEL_COUNTER]: 1 },
            gauges: { [IPC_INVOKE_ACTIVE_GAUGE]: 0 },
            latencies: { [IPC_INVOKE_METRIC]: { count: 1 } },
        });
        expect(JSON.stringify(performanceTelemetry.snapshot())).not.toContain("privateCancellationReason");

        pending.resolve({ secretResult: "not retained" });
        await Promise.resolve();
        expect(JSON.stringify(performanceTelemetry.snapshot())).not.toContain("not retained");
    });

    it("does not derive categories from ordinary errors and never reuses request IDs", async () => {
        const firstError = new Error("private failure detail");
        rawInvoke.mockRejectedValueOnce(firstError);
        await expect(invokeCommand("first_command")).rejects.toBe(firstError);
        const firstRequestId = performanceTelemetry.snapshot().spans[0].metadata.requestId as number;

        performanceTelemetry.reset();
        rawInvoke.mockResolvedValueOnce(null);
        await invokeCommand<null>("second_command");

        const snapshot = performanceTelemetry.snapshot();
        expect(snapshot.spans[0].metadata.requestId).toBeGreaterThan(firstRequestId);
        expect(snapshot.spans[0].metadata).toEqual({
            command: "second_command",
            requestId: snapshot.spans[0].metadata.requestId,
            outcome: "success",
        });
        expect(JSON.stringify(snapshot)).not.toContain("private failure detail");
    });
});

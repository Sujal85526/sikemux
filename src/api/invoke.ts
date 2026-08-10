import { invoke, type InvokeArgs, type InvokeOptions } from "@tauri-apps/api/core";
import { performanceTelemetry } from "../lib/performance";

export const IPC_INVOKE_METRIC = "ipc.invoke";
export const IPC_INVOKE_SUCCESS_COUNTER = "ipc.invoke.success";
export const IPC_INVOKE_ERROR_COUNTER = "ipc.invoke.error";
export const IPC_INVOKE_CANCEL_COUNTER = "ipc.invoke.cancel";
export const IPC_INVOKE_ACTIVE_GAUGE = "ipc.invoke.active";

export interface InvokeCommandOptions {
    readonly signal?: AbortSignal;
    readonly invokeOptions?: InvokeOptions;
}

type InvokeOutcome<T> =
    | { readonly kind: "success"; readonly value: T }
    | { readonly kind: "error"; readonly error: unknown }
    | { readonly kind: "cancel"; readonly reason: unknown };

let requestSequence = 0;
let activeInvocations = 0;

function nextRequestId(): number {
    if (requestSequence >= Number.MAX_SAFE_INTEGER) throw new RangeError("IPC request ID space exhausted");
    requestSequence += 1;
    return requestSequence;
}

function errorCategory(error: unknown): string | undefined {
    if (typeof error !== "object" || error === null) return undefined;
    try {
        const descriptor = Object.getOwnPropertyDescriptor(error, "category");
        if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string") return undefined;
        return descriptor.value;
    } catch {
        return undefined;
    }
}

function settleInvocation<T>(command: string, args: InvokeArgs | undefined, options: InvokeCommandOptions | undefined): Promise<InvokeOutcome<T>> {
    const signal = options?.signal;
    if (signal?.aborted) return Promise.resolve({ kind: "cancel", reason: signal.reason });

    let pending: Promise<T>;
    try {
        // Args are deliberately passed through by identity. In particular, do not
        // clone or enumerate them: Tauri Channel instances carry serialization hooks.
        pending = invoke<T>(command, args, options?.invokeOptions);
    } catch (error) {
        return Promise.resolve({ kind: "error", error });
    }

    if (!signal) {
        return pending.then(
            (value) => ({ kind: "success", value }),
            (error: unknown) => ({ kind: "error", error }),
        );
    }

    return new Promise((resolve) => {
        let settled = false;
        const finish = (outcome: InvokeOutcome<T>) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener("abort", onAbort);
            resolve(outcome);
        };
        const onAbort = () => finish({ kind: "cancel", reason: signal.reason });

        signal.addEventListener("abort", onAbort, { once: true });
        // Cover an abort between the initial check and listener registration.
        if (signal.aborted) onAbort();
        pending.then(
            (value) => finish({ kind: "success", value }),
            (error: unknown) => finish({ kind: "error", error }),
        );
    });
}

/**
 * Invoke a native command while retaining only its name, request ID, duration,
 * and outcome. Arguments, return values, and error details remain opaque.
 */
export async function invokeCommand<T>(command: string, args?: InvokeArgs, options?: InvokeCommandOptions): Promise<T> {
    const requestId = nextRequestId();
    const span = performanceTelemetry.startTrace(IPC_INVOKE_METRIC, { command, requestId });
    activeInvocations += 1;
    performanceTelemetry.setGauge(IPC_INVOKE_ACTIVE_GAUGE, activeInvocations);

    const outcome = await settleInvocation<T>(command, args, options);
    activeInvocations -= 1;
    performanceTelemetry.setGauge(IPC_INVOKE_ACTIVE_GAUGE, activeInvocations);

    if (outcome.kind === "success") {
        performanceTelemetry.incrementCounter(IPC_INVOKE_SUCCESS_COUNTER);
        const recorded = performanceTelemetry.endSpan(span, { outcome: "success" });
        if (recorded) performanceTelemetry.recordLatency(IPC_INVOKE_METRIC, recorded.durationMs);
        return outcome.value;
    }

    if (outcome.kind === "cancel") {
        performanceTelemetry.incrementCounter(IPC_INVOKE_CANCEL_COUNTER);
        const recorded = performanceTelemetry.endSpan(span, { outcome: "cancel" });
        if (recorded) performanceTelemetry.recordLatency(IPC_INVOKE_METRIC, recorded.durationMs);
        throw outcome.reason;
    }

    performanceTelemetry.incrementCounter(IPC_INVOKE_ERROR_COUNTER);
    const category = errorCategory(outcome.error);
    const recorded = performanceTelemetry.endSpan(span, category ? { outcome: "error", category } : { outcome: "error" });
    if (recorded) performanceTelemetry.recordLatency(IPC_INVOKE_METRIC, recorded.durationMs);
    throw outcome.error;
}

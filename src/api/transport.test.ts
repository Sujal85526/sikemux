import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    MemoryIpcTransport,
    createIpcTransport,
    getIpcTransport,
    installIpcTransportForTests,
    productionIpcTransport,
    resetIpcTransportForTests,
    type IpcEvent,
    type IpcEventListener,
    type IpcTransportBindings,
} from "./transport";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function bindings(overrides: Partial<IpcTransportBindings> = {}): IpcTransportBindings {
    return {
        invoke: async () => undefined as never,
        subscribe: async () => () => {},
        ...overrides,
    };
}

beforeEach(() => {
    resetIpcTransportForTests();
    mocks.invoke.mockReset();
    mocks.listen.mockReset();
});

describe("production IPC transport", () => {
    it("is the default and preserves opaque Channel-compatible args, native options, and call arity", async () => {
        let enumerations = 0;
        const args = new Proxy(
            { opaqueChannel: Object.freeze({ id: 7 }) },
            {
                ownKeys: () => {
                    enumerations += 1;
                    throw new Error("transport enumerated opaque args");
                },
                getOwnPropertyDescriptor: () => {
                    enumerations += 1;
                    throw new Error("transport inspected opaque args");
                },
            },
        );
        const native = Object.freeze({ headers: Object.freeze({ "x-test": "opaque" }) });
        const result = Object.freeze({ marker: "result" });
        mocks.invoke.mockImplementation((_command, receivedArgs, receivedNative) => {
            expect(receivedArgs).toBe(args);
            expect(receivedNative).toBe(native);
            return Promise.resolve(result);
        });

        expect(getIpcTransport()).toBe(productionIpcTransport);
        await expect(getIpcTransport().invoke("pty_attach", args, { native })).resolves.toBe(result);
        expect(enumerations).toBe(0);
        expect(mocks.invoke.mock.calls[0]).toHaveLength(3);

        mocks.invoke.mockClear();
        mocks.invoke.mockResolvedValue(undefined);
        await getIpcTransport().invoke("integration_health");
        expect(mocks.invoke.mock.calls[0]).toEqual(["integration_health"]);
    });

    it("propagates cancellation and observes late invoke settlement", async () => {
        const pending = deferred<unknown>();
        const invoke = vi.fn(() => pending.promise);
        const transport = createIpcTransport(
            bindings({
                invoke: <Result>() => invoke() as Promise<Result>,
            }),
        );
        const controller = new AbortController();
        const reason = new Error("cancel invoke");
        const invocation = transport.invoke("slow_command", Object.freeze({ id: 1 }), { signal: controller.signal });

        controller.abort(reason);
        await expect(invocation).rejects.toBe(reason);
        pending.reject(new Error("late native rejection"));
        await Promise.resolve();

        const preAborted = new AbortController();
        preAborted.abort(reason);
        await expect(transport.invoke("never_called", undefined, { signal: preAborted.signal })).rejects.toBe(reason);
        expect(invoke).toHaveBeenCalledOnce();
    });

    it("cleans up a late subscription after abort and contains unsubscribe rejection", async () => {
        const pending = deferred<() => Promise<void>>();
        let nativeListener: IpcEventListener<number> | null = null;
        const subscribe = vi.fn((_event, listener) => {
            nativeListener = listener as IpcEventListener<number>;
            return pending.promise;
        });
        const unsubscribeError = new Error("late cleanup failed");
        const rawUnsubscribe = vi.fn(async () => {
            throw unsubscribeError;
        });
        const unsubscribeErrors: unknown[] = [];
        const transport = createIpcTransport(bindings({ subscribe }), {
            onUnsubscribeError: (_event, error) => unsubscribeErrors.push(error),
        });
        const controller = new AbortController();
        const reason = new Error("cancel subscribe");
        const listener = vi.fn();
        const subscribing = transport.subscribe("git_changed", listener, { signal: controller.signal });

        controller.abort(reason);
        await expect(subscribing).rejects.toBe(reason);
        pending.resolve(rawUnsubscribe);
        await vi.waitFor(() => expect(rawUnsubscribe).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(unsubscribeErrors).toEqual([unsubscribeError]));

        expect(() => nativeListener?.({ event: "git_changed", id: 1, payload: 7 })).not.toThrow();
        expect(listener).not.toHaveBeenCalled();
    });

    it("contains listener failures and abort-disposes an active typed subscription once", async () => {
        let nativeListener: IpcEventListener<{ readonly value: number }> | null = null;
        const rawUnsubscribe = vi.fn();
        const nativeOptions = Object.freeze({ target: "main" });
        mocks.listen.mockImplementation((_event, listener, receivedOptions) => {
            nativeListener = listener;
            expect(receivedOptions).toBe(nativeOptions);
            return Promise.resolve(rawUnsubscribe);
        });
        const listenerError = new Error("listener failed");
        const listenerErrors: unknown[] = [];
        const transport = createIpcTransport(
            {
                invoke: async () => undefined as never,
                subscribe: productionBindingSubscribe,
            },
            { onListenerError: (_event, error) => listenerErrors.push(error) },
        );
        const controller = new AbortController();
        const unlisten = await transport.subscribe<{ readonly value: number }>(
            "lsp_diagnostics",
            () => {
                throw listenerError;
            },
            { signal: controller.signal, native: nativeOptions },
        );

        const event = Object.freeze({ event: "lsp_diagnostics", id: 9, payload: Object.freeze({ value: 3 }) });
        expect(() => nativeListener?.(event)).not.toThrow();
        expect(listenerErrors).toEqual([listenerError]);

        controller.abort();
        unlisten();
        expect(rawUnsubscribe).toHaveBeenCalledOnce();
    });
});

async function productionBindingSubscribe<Payload>(event: string, listener: IpcEventListener<Payload>, nativeOptions?: unknown): Promise<() => void> {
    return mocks.listen(event, listener, nativeOptions) as Promise<() => void>;
}

describe("IPC test installation seam", () => {
    it("installs one isolated override and restores the production default explicitly", async () => {
        const memory = new MemoryIpcTransport();
        memory.register("ping", async () => "pong");
        const reset = installIpcTransportForTests(memory);

        expect(getIpcTransport()).toBe(memory);
        await expect(getIpcTransport().invoke("ping")).resolves.toBe("pong");
        expect(() => installIpcTransportForTests(new MemoryIpcTransport())).toThrow("already installed");

        reset();
        reset();
        expect(getIpcTransport()).toBe(productionIpcTransport);

        const staleReset = installIpcTransportForTests(memory);
        resetIpcTransportForTests();
        expect(getIpcTransport()).toBe(productionIpcTransport);

        const currentReset = installIpcTransportForTests(memory);
        staleReset();
        expect(getIpcTransport()).toBe(memory);
        currentReset();
    });
});

describe("MemoryIpcTransport", () => {
    it("passes opaque args and cancellation through without retaining late results", async () => {
        const pending = deferred<unknown>();
        let enumerations = 0;
        const args = new Proxy(
            {},
            {
                ownKeys: () => {
                    enumerations += 1;
                    throw new Error("memory transport enumerated args");
                },
            },
        );
        const native = Object.freeze({ channelMode: true });
        const handler = vi.fn((receivedArgs, context) => {
            expect(receivedArgs).toBe(args);
            expect(context.native).toBe(native);
            return pending.promise;
        });
        const memory = new MemoryIpcTransport();
        memory.register("stream", handler);
        const controller = new AbortController();
        const reason = new Error("cancel memory invoke");
        const invocation = memory.invoke("stream", args, { signal: controller.signal, native });

        controller.abort(reason);
        await expect(invocation).rejects.toBe(reason);
        expect(enumerations).toBe(0);
        expect(handler).toHaveBeenCalledOnce();
        pending.resolve("late value");
        await Promise.resolve();
    });

    it("bounds handlers, event names, and listeners while containing event errors", async () => {
        const listenerError = new Error("test listener failed");
        const listenerErrors: unknown[] = [];
        const memory = new MemoryIpcTransport({
            maxCommandHandlers: 1,
            maxEventNames: 1,
            maxListenersPerEvent: 1,
            maxListeners: 1,
            onListenerError: (_event, error) => listenerErrors.push(error),
        });
        const unregister = memory.register("one", async () => 1);
        expect(() => memory.register("two", async () => 2)).toThrow("limit");
        unregister();
        memory.register("two", async () => 2);

        const payload = Object.freeze({ marker: "event" });
        let received: IpcEvent<typeof payload> | null = null;
        const unlisten = await memory.subscribe<typeof payload>("changed", (event) => {
            received = event;
            throw listenerError;
        });
        await expect(memory.subscribe("changed", vi.fn())).rejects.toThrow("listener limit");
        await expect(memory.subscribe("other", vi.fn())).rejects.toThrow("listener limit");

        expect(memory.emit("changed", payload)).toEqual({ delivered: 0, listenerErrors: 1 });
        expect(received).toMatchObject({ event: "changed", id: 1, payload });
        expect(Object.isFrozen(received)).toBe(true);
        expect(listenerErrors).toEqual([listenerError]);

        unlisten();
        unlisten();
        expect(memory.eventListenerCount).toBe(0);
        const controller = new AbortController();
        await memory.subscribe("other", vi.fn(), { signal: controller.signal });
        controller.abort();
        expect(memory.eventListenerCount).toBe(0);

        const eventBounded = new MemoryIpcTransport({ maxEventNames: 1, maxListenersPerEvent: 2, maxListeners: 2 });
        await eventBounded.subscribe("first", vi.fn());
        await expect(eventBounded.subscribe("second", vi.fn())).rejects.toThrow("event name limit");

        memory.reset();
        expect(memory.commandHandlerCount).toBe(0);
        let resetEvent: IpcEvent<typeof payload> | null = null;
        await memory.subscribe<typeof payload>("changed", (event) => {
            resetEvent = event;
        });
        memory.emit("changed", payload);
        expect(resetEvent).toMatchObject({ id: 1 });
    });

    it("keeps registrations isolated from stale disposal after reset", async () => {
        const memory = new MemoryIpcTransport();
        const handler = async () => "shared";
        const staleUnregister = memory.register("same", handler);

        memory.reset();
        memory.register("same", handler);
        staleUnregister();

        await expect(memory.invoke("same")).resolves.toBe("shared");
    });
});

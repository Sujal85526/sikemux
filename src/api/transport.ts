import { invoke as tauriInvoke, type InvokeArgs, type InvokeOptions } from "@tauri-apps/api/core";
import { listen as tauriListen, type Event as TauriEvent, type Options as TauriEventOptions } from "@tauri-apps/api/event";

export const IPC_TRANSPORT_LIMITS = Object.freeze({
    maxCommandLength: 128,
    maxEventNameLength: 128,
    maxMemoryCommandHandlers: 256,
    maxMemoryEventNames: 128,
    maxMemoryListenersPerEvent: 64,
    maxMemoryListeners: 1024,
});

export type IpcInvokeArguments = unknown;
export type IpcNativeOptions = unknown;

export interface IpcInvokeOptions {
    readonly signal?: AbortSignal;
    /** Opaque adapter-specific options, passed through without inspection. */
    readonly native?: IpcNativeOptions;
}

export interface IpcSubscribeOptions {
    readonly signal?: AbortSignal;
    /** Opaque adapter-specific options, passed through without inspection. */
    readonly native?: IpcNativeOptions;
}

export interface IpcEvent<Payload> {
    readonly event: string;
    readonly id: number;
    readonly payload: Payload;
}

export type IpcEventListener<Payload> = (event: IpcEvent<Payload>) => void;
export type IpcUnsubscribe = () => void;

export interface IpcTransport {
    invoke<Result>(command: string, args?: IpcInvokeArguments, options?: IpcInvokeOptions): Promise<Result>;
    subscribe<Payload>(event: string, listener: IpcEventListener<Payload>, options?: IpcSubscribeOptions): Promise<IpcUnsubscribe>;
}

export interface IpcTransportBindings {
    invoke<Result>(command: string, args?: IpcInvokeArguments, nativeOptions?: IpcNativeOptions): Promise<Result>;
    subscribe<Payload>(event: string, listener: IpcEventListener<Payload>, nativeOptions?: IpcNativeOptions): Promise<() => void | PromiseLike<void>>;
}

export interface IpcTransportAdapterOptions {
    readonly onListenerError?: (event: string, error: unknown) => void;
    readonly onUnsubscribeError?: (event: string, error: unknown) => void;
}

const EVENT_NAME = /^[a-zA-Z0-9_:/-]+$/u;

function requireBoundedName(kind: "command" | "event", value: string): string {
    if (typeof value !== "string" || value.length === 0) throw new TypeError(`IPC ${kind} name must be a non-empty string`);
    const limit = kind === "command" ? IPC_TRANSPORT_LIMITS.maxCommandLength : IPC_TRANSPORT_LIMITS.maxEventNameLength;
    if (value.length > limit) throw new RangeError(`IPC ${kind} name cannot exceed ${limit} characters`);
    if (kind === "event" && !EVENT_NAME.test(value)) throw new TypeError("IPC event name contains unsupported characters");
    return value;
}

function abortReason(signal: AbortSignal): unknown {
    return signal.reason === undefined ? new DOMException("The IPC operation was aborted", "AbortError") : signal.reason;
}

/** Race cancellation while retaining handlers on the late transport promise. */
function runAbortable<Result>(signal: AbortSignal | undefined, operation: () => Result | PromiseLike<Result>): Promise<Result> {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    return new Promise<Result>((resolve, reject) => {
        let settled = false;
        const finish = () => {
            if (settled) return false;
            settled = true;
            signal?.removeEventListener("abort", onAbort);
            return true;
        };
        const resolveOnce = (value: Result) => {
            if (finish()) resolve(value);
        };
        const rejectOnce = (error: unknown) => {
            if (finish()) reject(error);
        };
        const onAbort = () => {
            if (signal) rejectOnce(abortReason(signal));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) {
            onAbort();
            return;
        }

        let result: Result | PromiseLike<Result>;
        try {
            result = operation();
        } catch (error) {
            rejectOnce(error);
            return;
        }
        Promise.resolve(result).then(resolveOnce, rejectOnce);
    });
}

function callInvokeBinding<Result>(
    binding: IpcTransportBindings["invoke"],
    command: string,
    args: IpcInvokeArguments | undefined,
    nativeOptions: IpcNativeOptions | undefined,
): Promise<Result> {
    // Preserve exact arity and argument identity. Tauri Channel values expose
    // special serialization hooks and must never be cloned or enumerated.
    if (nativeOptions !== undefined) return binding<Result>(command, args, nativeOptions);
    if (args !== undefined) return binding<Result>(command, args);
    return binding<Result>(command);
}

function callSubscribeBinding<Payload>(
    binding: IpcTransportBindings["subscribe"],
    event: string,
    listener: IpcEventListener<Payload>,
    nativeOptions: IpcNativeOptions | undefined,
): Promise<() => void | PromiseLike<void>> {
    if (nativeOptions !== undefined) return binding<Payload>(event, listener, nativeOptions);
    return binding<Payload>(event, listener);
}

class BindingIpcTransport implements IpcTransport {
    private readonly bindings: IpcTransportBindings;
    private readonly onListenerError?: (event: string, error: unknown) => void;
    private readonly onUnsubscribeError?: (event: string, error: unknown) => void;

    constructor(bindings: IpcTransportBindings, options: IpcTransportAdapterOptions) {
        if (typeof bindings?.invoke !== "function" || typeof bindings.subscribe !== "function") {
            throw new TypeError("IPC transport bindings require invoke and subscribe functions");
        }
        if (options.onListenerError !== undefined && typeof options.onListenerError !== "function") {
            throw new TypeError("IPC listener error observer must be a function");
        }
        if (options.onUnsubscribeError !== undefined && typeof options.onUnsubscribeError !== "function") {
            throw new TypeError("IPC unsubscribe error observer must be a function");
        }
        this.bindings = bindings;
        this.onListenerError = options.onListenerError;
        this.onUnsubscribeError = options.onUnsubscribeError;
    }

    invoke<Result>(commandInput: string, args?: IpcInvokeArguments, options: IpcInvokeOptions = {}): Promise<Result> {
        let command: string;
        try {
            command = requireBoundedName("command", commandInput);
        } catch (error) {
            return Promise.reject(error);
        }
        return runAbortable(options.signal, () => callInvokeBinding<Result>(this.bindings.invoke, command, args, options.native));
    }

    subscribe<Payload>(eventInput: string, listener: IpcEventListener<Payload>, options: IpcSubscribeOptions = {}): Promise<IpcUnsubscribe> {
        let event: string;
        try {
            event = requireBoundedName("event", eventInput);
            if (typeof listener !== "function") throw new TypeError("IPC event listener must be a function");
        } catch (error) {
            return Promise.reject(error);
        }
        const signal = options.signal;
        if (signal?.aborted) return Promise.reject(abortReason(signal));

        return new Promise<IpcUnsubscribe>((resolve, reject) => {
            let promiseSettled = false;
            let aborted = false;
            let acceptEvents = true;
            let unsubscribe: IpcUnsubscribe | null = null;
            const finishReject = (error: unknown) => {
                if (promiseSettled) return;
                promiseSettled = true;
                signal?.removeEventListener("abort", onAbort);
                reject(error);
            };
            const onAbort = () => {
                aborted = true;
                acceptEvents = false;
                if (unsubscribe) unsubscribe();
                else if (signal) finishReject(abortReason(signal));
            };
            signal?.addEventListener("abort", onAbort, { once: true });
            if (signal?.aborted) {
                onAbort();
                return;
            }

            const guardedListener: IpcEventListener<Payload> = (received) => {
                if (!acceptEvents) return;
                try {
                    listener(received);
                } catch (error) {
                    try {
                        this.onListenerError?.(event, error);
                    } catch {
                        // Diagnostics observers cannot break event dispatch.
                    }
                }
            };

            let pending: Promise<() => void | PromiseLike<void>>;
            try {
                pending = callSubscribeBinding(this.bindings.subscribe, event, guardedListener, options.native);
            } catch (error) {
                finishReject(error);
                return;
            }
            Promise.resolve(pending).then(
                (rawUnsubscribe) => {
                    if (typeof rawUnsubscribe !== "function") {
                        finishReject(new TypeError("IPC subscribe binding returned an invalid unsubscribe function"));
                        return;
                    }
                    let active = true;
                    unsubscribe = () => {
                        if (!active) return;
                        active = false;
                        acceptEvents = false;
                        signal?.removeEventListener("abort", onAbort);
                        try {
                            Promise.resolve(rawUnsubscribe()).catch((error: unknown) => {
                                try {
                                    this.onUnsubscribeError?.(event, error);
                                } catch {
                                    // Diagnostics observers cannot break cleanup.
                                }
                            });
                        } catch (error) {
                            try {
                                this.onUnsubscribeError?.(event, error);
                            } catch {
                                // Diagnostics observers cannot break cleanup.
                            }
                        }
                    };
                    if (aborted) {
                        unsubscribe();
                        if (!promiseSettled && signal) finishReject(abortReason(signal));
                        return;
                    }
                    if (promiseSettled) {
                        unsubscribe();
                        return;
                    }
                    promiseSettled = true;
                    resolve(unsubscribe);
                },
                (error: unknown) => finishReject(error),
            );
        });
    }
}

export function createIpcTransport(bindings: IpcTransportBindings, options: IpcTransportAdapterOptions = {}): IpcTransport {
    return new BindingIpcTransport(bindings, options);
}

const productionBindings: IpcTransportBindings = {
    invoke<Result>(command: string, args?: IpcInvokeArguments, nativeOptions?: IpcNativeOptions): Promise<Result> {
        const tauriArgs = args as InvokeArgs | undefined;
        if (nativeOptions !== undefined) return tauriInvoke<Result>(command, tauriArgs, nativeOptions as InvokeOptions);
        if (args !== undefined) return tauriInvoke<Result>(command, tauriArgs);
        return tauriInvoke<Result>(command);
    },
    subscribe<Payload>(
        event: string,
        listener: IpcEventListener<Payload>,
        nativeOptions?: IpcNativeOptions,
    ): Promise<() => void | PromiseLike<void>> {
        const tauriListener = listener as (event: TauriEvent<Payload>) => void;
        if (nativeOptions !== undefined) return tauriListen<Payload>(event, tauriListener, nativeOptions as TauriEventOptions);
        return tauriListen<Payload>(event, tauriListener);
    },
};

export const productionIpcTransport: IpcTransport = createIpcTransport(productionBindings);

interface TestTransportInstallation {
    readonly transport: IpcTransport;
}

let testTransportInstallation: TestTransportInstallation | null = null;

export function getIpcTransport(): IpcTransport {
    return testTransportInstallation?.transport ?? productionIpcTransport;
}

/** Install one isolated override. Tests must reset before installing another. */
export function installIpcTransportForTests(transport: IpcTransport): () => void {
    if (testTransportInstallation) throw new Error("An IPC test transport is already installed");
    if (typeof transport?.invoke !== "function" || typeof transport.subscribe !== "function") {
        throw new TypeError("IPC test transport requires invoke and subscribe functions");
    }
    const installation = Object.freeze({ transport });
    testTransportInstallation = installation;
    let active = true;
    return () => {
        if (!active) return;
        active = false;
        if (testTransportInstallation === installation) testTransportInstallation = null;
    };
}

export function resetIpcTransportForTests(): void {
    testTransportInstallation = null;
}

export interface MemoryIpcTransportOptions {
    readonly maxCommandHandlers?: number;
    readonly maxEventNames?: number;
    readonly maxListenersPerEvent?: number;
    readonly maxListeners?: number;
    readonly onListenerError?: (event: string, error: unknown) => void;
}

export interface MemoryInvokeContext {
    readonly command: string;
    readonly signal?: AbortSignal;
    readonly native?: IpcNativeOptions;
}

export type MemoryInvokeHandler = (args: IpcInvokeArguments | undefined, context: MemoryInvokeContext) => unknown | PromiseLike<unknown>;

export interface MemoryEventDispatchResult {
    readonly delivered: number;
    readonly listenerErrors: number;
}

interface MemoryListener {
    readonly listener: IpcEventListener<unknown>;
    readonly signal?: AbortSignal;
    onAbort?: () => void;
    active: boolean;
}

function requireMemoryLimit(name: string, value: number | undefined, fallback: number, hardLimit: number): number {
    const selected = value ?? fallback;
    if (!Number.isSafeInteger(selected) || selected < 1 || selected > hardLimit) {
        throw new RangeError(`${name} must be an integer from 1 through ${hardLimit}`);
    }
    return selected;
}

/** Bounded deterministic transport for E2E-style frontend tests. */
export class MemoryIpcTransport implements IpcTransport {
    private readonly handlers = new Map<string, { readonly handler: MemoryInvokeHandler }>();
    private readonly listeners = new Map<string, Set<MemoryListener>>();
    private readonly maxCommandHandlers: number;
    private readonly maxEventNames: number;
    private readonly maxListenersPerEvent: number;
    private readonly maxListeners: number;
    private readonly onListenerError?: (event: string, error: unknown) => void;
    private listenerCount = 0;
    private eventSequence = 0;

    constructor(options: MemoryIpcTransportOptions = {}) {
        this.maxCommandHandlers = requireMemoryLimit(
            "Memory IPC command handler limit",
            options.maxCommandHandlers,
            IPC_TRANSPORT_LIMITS.maxMemoryCommandHandlers,
            IPC_TRANSPORT_LIMITS.maxMemoryCommandHandlers,
        );
        this.maxEventNames = requireMemoryLimit(
            "Memory IPC event name limit",
            options.maxEventNames,
            IPC_TRANSPORT_LIMITS.maxMemoryEventNames,
            IPC_TRANSPORT_LIMITS.maxMemoryEventNames,
        );
        this.maxListenersPerEvent = requireMemoryLimit(
            "Memory IPC per-event listener limit",
            options.maxListenersPerEvent,
            IPC_TRANSPORT_LIMITS.maxMemoryListenersPerEvent,
            IPC_TRANSPORT_LIMITS.maxMemoryListenersPerEvent,
        );
        this.maxListeners = requireMemoryLimit(
            "Memory IPC listener limit",
            options.maxListeners,
            IPC_TRANSPORT_LIMITS.maxMemoryListeners,
            IPC_TRANSPORT_LIMITS.maxMemoryListeners,
        );
        if (options.onListenerError !== undefined && typeof options.onListenerError !== "function") {
            throw new TypeError("Memory IPC listener error observer must be a function");
        }
        this.onListenerError = options.onListenerError;
    }

    get commandHandlerCount(): number {
        return this.handlers.size;
    }

    get eventListenerCount(): number {
        return this.listenerCount;
    }

    register(commandInput: string, handler: MemoryInvokeHandler): () => void {
        const command = requireBoundedName("command", commandInput);
        if (typeof handler !== "function") throw new TypeError("Memory IPC command handler must be a function");
        if (this.handlers.has(command)) throw new TypeError(`Memory IPC command already registered: ${command}`);
        if (this.handlers.size >= this.maxCommandHandlers) throw new RangeError("Memory IPC command handler limit reached");
        const registration = Object.freeze({ handler });
        this.handlers.set(command, registration);
        let active = true;
        return () => {
            if (!active) return;
            active = false;
            if (this.handlers.get(command) === registration) this.handlers.delete(command);
        };
    }

    invoke<Result>(commandInput: string, args?: IpcInvokeArguments, options: IpcInvokeOptions = {}): Promise<Result> {
        let command: string;
        let handler: MemoryInvokeHandler;
        try {
            command = requireBoundedName("command", commandInput);
            const resolved = this.handlers.get(command);
            if (!resolved) throw new Error(`No memory IPC handler registered for ${command}`);
            handler = resolved.handler;
        } catch (error) {
            return Promise.reject(error);
        }
        const context = Object.freeze({
            command,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            ...(options.native === undefined ? {} : { native: options.native }),
        });
        return runAbortable(options.signal, () => handler(args, context) as Result | PromiseLike<Result>);
    }

    subscribe<Payload>(eventInput: string, listener: IpcEventListener<Payload>, options: IpcSubscribeOptions = {}): Promise<IpcUnsubscribe> {
        let event: string;
        try {
            event = requireBoundedName("event", eventInput);
            if (typeof listener !== "function") throw new TypeError("Memory IPC event listener must be a function");
            if (options.signal?.aborted) throw abortReason(options.signal);
        } catch (error) {
            return Promise.reject(error);
        }

        let group = this.listeners.get(event);
        if (this.listenerCount >= this.maxListeners) return Promise.reject(new RangeError("Memory IPC listener limit reached"));
        if (!group) {
            if (this.listeners.size >= this.maxEventNames) return Promise.reject(new RangeError("Memory IPC event name limit reached"));
            group = new Set();
            this.listeners.set(event, group);
        }
        if (group.size >= this.maxListenersPerEvent) return Promise.reject(new RangeError("Memory IPC per-event listener limit reached"));

        const record: MemoryListener = { listener: listener as IpcEventListener<unknown>, signal: options.signal, active: true };
        const unsubscribe = () => {
            if (!record.active) return;
            record.active = false;
            if (record.onAbort) record.signal?.removeEventListener("abort", record.onAbort);
            group?.delete(record);
            this.listenerCount -= 1;
            if (group?.size === 0) this.listeners.delete(event);
        };
        if (options.signal) {
            const onAbort = () => unsubscribe();
            record.onAbort = onAbort;
            options.signal.addEventListener("abort", onAbort, { once: true });
        }
        group.add(record);
        this.listenerCount += 1;
        if (options.signal?.aborted) unsubscribe();
        return Promise.resolve(unsubscribe);
    }

    emit<Payload>(eventInput: string, payload: Payload): MemoryEventDispatchResult {
        const event = requireBoundedName("event", eventInput);
        if (this.eventSequence >= Number.MAX_SAFE_INTEGER) throw new RangeError("Memory IPC event ID space exhausted");
        this.eventSequence += 1;
        const received = Object.freeze({ event, id: this.eventSequence, payload });
        let delivered = 0;
        let listenerErrors = 0;
        const group = this.listeners.get(event);
        if (!group) return Object.freeze({ delivered, listenerErrors });
        for (const record of Array.from(group)) {
            if (!record.active) continue;
            try {
                record.listener(received);
                delivered += 1;
            } catch (error) {
                listenerErrors += 1;
                try {
                    this.onListenerError?.(event, error);
                } catch {
                    // Test diagnostics observers cannot break deterministic dispatch.
                }
            }
        }
        return Object.freeze({ delivered, listenerErrors });
    }

    reset(): void {
        this.handlers.clear();
        for (const group of this.listeners.values()) {
            for (const record of group) {
                record.active = false;
                if (record.onAbort) record.signal?.removeEventListener("abort", record.onAbort);
            }
        }
        this.listeners.clear();
        this.listenerCount = 0;
        this.eventSequence = 0;
    }
}

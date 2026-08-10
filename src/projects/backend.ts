export const PROJECT_BACKEND_LIMITS = Object.freeze({
    maxPathLength: 4096,
    maxHostLength: 512,
    maxUserLength: 256,
    maxOperationLength: 128,
    defaultMaxRegistrations: 2,
    hardMaxRegistrations: 16,
});

export type ProjectScheme = "local" | "ssh";

export interface LocalProjectLocation {
    readonly scheme: "local";
    readonly path: string;
}

export interface SshProjectLocation {
    readonly scheme: "ssh";
    readonly host: string;
    readonly path: string;
    readonly user?: string;
    readonly port?: number;
}

export type ProjectLocation = LocalProjectLocation | SshProjectLocation;

const WINDOWS_ABSOLUTE_PATH = /^(?:[a-zA-Z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/u;
const SSH_USER = /^[a-zA-Z0-9._-]+$/u;
const DNS_OR_IPV4_HOST = /^[a-zA-Z0-9._-]+$/u;
const IPV6_GROUP = /^[a-fA-F0-9]{1,4}$/u;
const IPV6_ZONE = /^[a-zA-Z0-9_.-]+$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function containsControlCharacters(value: string): boolean {
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code <= 0x1f || code === 0x7f) return true;
    }
    return false;
}

function requireOnlyKeys(record: Record<string, unknown>, allowed: readonly string[], subject: string): void {
    for (const key of Object.keys(record)) {
        if (!allowed.includes(key)) throw new TypeError(`Unknown ${subject} field: ${key}`);
    }
}

function requireBoundedString(name: string, value: unknown, maxLength: number): string {
    if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} must be a non-empty string`);
    if (value.length > maxLength) throw new RangeError(`${name} cannot exceed ${maxLength} characters`);
    if (containsControlCharacters(value)) throw new TypeError(`${name} cannot contain control characters`);
    return value;
}

function requireProjectPath(value: unknown, scheme: ProjectScheme): string {
    const path = requireBoundedString("project path", value, PROJECT_BACKEND_LIMITS.maxPathLength);
    const absolute = scheme === "ssh" ? path.startsWith("/") : path.startsWith("/") || WINDOWS_ABSOLUTE_PATH.test(path);
    if (!absolute) throw new TypeError(`${scheme} project paths must be absolute`);
    return path;
}

function isIpv4Address(value: string): boolean {
    const octets = value.split(".");
    return octets.length === 4 && octets.every((octet) => octet.length > 0 && octet.length <= 3 && /^\d+$/u.test(octet) && Number(octet) <= 255);
}

function isIpv6Address(value: string): boolean {
    const compressionIndex = value.indexOf("::");
    if (compressionIndex !== value.lastIndexOf("::")) return false;
    const compressed = compressionIndex >= 0;
    const sides = compressed ? [value.slice(0, compressionIndex), value.slice(compressionIndex + 2)] : [value];
    const groups = sides.flatMap((side) => (side.length === 0 ? [] : side.split(":")));
    let width = 0;
    for (const [index, group] of groups.entries()) {
        if (group.includes(".")) {
            if (index !== groups.length - 1 || !isIpv4Address(group)) return false;
            width += 2;
        } else {
            if (!IPV6_GROUP.test(group)) return false;
            width += 1;
        }
    }
    return compressed ? width < 8 : width === 8;
}

function requireSshHost(value: unknown): string {
    let host = requireBoundedString("SSH host", value, PROJECT_BACKEND_LIMITS.maxHostLength);
    if (host !== host.trim()) throw new TypeError("SSH host cannot have surrounding whitespace");
    if (host.startsWith("[") || host.endsWith("]")) {
        if (!(host.startsWith("[") && host.endsWith("]"))) throw new TypeError("SSH IPv6 brackets must be balanced");
        host = host.slice(1, -1);
    }
    if (host.length === 0 || host.includes("/") || host.includes("\\") || host.includes("@") || /\s/u.test(host)) {
        throw new TypeError("SSH host is invalid");
    }
    if (!host.includes(":")) {
        if (!DNS_OR_IPV4_HOST.test(host)) throw new TypeError("SSH host is invalid");
        return host.toLowerCase();
    }
    const [address, zone, ...extra] = host.split("%");
    if (extra.length > 0 || !isIpv6Address(address) || (zone !== undefined && !IPV6_ZONE.test(zone))) {
        throw new TypeError("SSH host is invalid");
    }
    return `${address.toLowerCase()}${zone === undefined ? "" : `%${zone}`}`;
}

function requireSshUser(value: unknown): string {
    const user = requireBoundedString("SSH user", value, PROJECT_BACKEND_LIMITS.maxUserLength);
    if (!SSH_USER.test(user)) throw new TypeError("SSH user is invalid");
    return user;
}

function requireSshPort(value: unknown): number {
    if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 65_535) {
        throw new RangeError("SSH port must be an integer from 1 through 65535");
    }
    return value as number;
}

/** Validate, copy, canonicalize, and freeze an untrusted project location. */
export function createProjectLocation(input: unknown): ProjectLocation {
    if (!isRecord(input)) throw new TypeError("Project location must be an object");
    if (input.scheme === "local") {
        requireOnlyKeys(input, ["scheme", "path"], "project location");
        return Object.freeze({ scheme: "local", path: requireProjectPath(input.path, "local") });
    }
    if (input.scheme === "ssh") {
        requireOnlyKeys(input, ["scheme", "host", "path", "user", "port"], "project location");
        const user = input.user === undefined ? undefined : requireSshUser(input.user);
        const port = input.port === undefined ? undefined : requireSshPort(input.port);
        return Object.freeze({
            scheme: "ssh",
            host: requireSshHost(input.host),
            path: requireProjectPath(input.path, "ssh"),
            ...(user === undefined ? {} : { user }),
            ...(port === undefined ? {} : { port }),
        });
    }
    throw new TypeError("Project location scheme must be local or ssh");
}

function keyPart(value: string): string {
    return `${value.length}:${value}`;
}

/**
 * Canonical, injective identity. Length-prefixed components prevent delimiter,
 * IPv6-colon, user/host-boundary, and path-prefix collisions.
 */
export function projectKey(input: ProjectLocation): string {
    const location = createProjectLocation(input);
    if (location.scheme === "local") return `local|p${keyPart(location.path)}`;
    return [
        "ssh",
        `u${keyPart(location.user ?? "")}`,
        `h${keyPart(location.host)}`,
        `o${location.port === undefined ? "-" : location.port.toString(10)}`,
        `p${keyPart(location.path)}`,
    ].join("|");
}

export const PROJECT_CAPABILITY_NAMES = Object.freeze(["files", "watch", "pty", "lsp", "git", "tasks"] as const);
export type ProjectCapability = (typeof PROJECT_CAPABILITY_NAMES)[number];

export interface ProjectCapabilities {
    readonly files: boolean;
    readonly watch: boolean;
    readonly pty: boolean;
    readonly lsp: boolean;
    readonly git: boolean;
    readonly tasks: boolean;
}

function isProjectCapability(value: unknown): value is ProjectCapability {
    return typeof value === "string" && PROJECT_CAPABILITY_NAMES.some((capability) => capability === value);
}

export function createProjectCapabilities(enabled: readonly ProjectCapability[]): ProjectCapabilities {
    if (!Array.isArray(enabled)) throw new TypeError("Project capabilities must be an array");
    if (enabled.length > PROJECT_CAPABILITY_NAMES.length) {
        throw new RangeError(`Project capabilities cannot exceed ${PROJECT_CAPABILITY_NAMES.length} entries`);
    }
    const selected = new Set<ProjectCapability>();
    for (const capability of enabled) {
        if (!isProjectCapability(capability)) throw new TypeError(`Unknown project capability: ${String(capability)}`);
        selected.add(capability);
    }
    return Object.freeze({
        files: selected.has("files"),
        watch: selected.has("watch"),
        pty: selected.has("pty"),
        lsp: selected.has("lsp"),
        git: selected.has("git"),
        tasks: selected.has("tasks"),
    });
}

function copyCapabilities(capabilities: ProjectCapabilities): ProjectCapabilities {
    if (!isRecord(capabilities)) throw new TypeError("Project backend capabilities must be an object");
    requireOnlyKeys(capabilities, PROJECT_CAPABILITY_NAMES, "project capability");
    const enabled: ProjectCapability[] = [];
    for (const capability of PROJECT_CAPABILITY_NAMES) {
        if (typeof capabilities[capability] !== "boolean") {
            throw new TypeError(`Project backend capability ${capability} must be boolean`);
        }
        if (capabilities[capability]) enabled.push(capability);
    }
    return createProjectCapabilities(enabled);
}

export interface ProjectBackendRequest<Input = unknown> {
    readonly operation: string;
    readonly input?: Input;
}

export interface ProjectBackendCallOptions {
    readonly signal?: AbortSignal;
}

function validateRequest<Input>(request: ProjectBackendRequest<Input>): ProjectBackendRequest<Input> {
    if (!isRecord(request)) throw new TypeError("Project backend request must be an object");
    requireOnlyKeys(request, ["operation", "input"], "project request");
    const operation = requireBoundedString("Project operation", request.operation, PROJECT_BACKEND_LIMITS.maxOperationLength);
    return Object.freeze({ operation, ...(Object.hasOwn(request, "input") ? { input: request.input as Input } : {}) });
}

function abortReason(signal: AbortSignal): unknown {
    return signal.reason === undefined ? new DOMException("The project operation was aborted", "AbortError") : signal.reason;
}

function runAbortable<Result>(signal: AbortSignal | undefined, operation: () => Result | PromiseLike<Result>): Promise<Result> {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    return new Promise<Result>((resolve, reject) => {
        let settled = false;
        const beginFinish = () => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener("abort", onAbort);
            return true;
        };
        const resolveOnce = (value: Result) => {
            if (beginFinish()) resolve(value);
        };
        const rejectOnce = (error: unknown) => {
            if (beginFinish()) reject(error);
        };
        const onAbort = () => rejectOnce(abortReason(signal as AbortSignal));
        signal?.addEventListener("abort", onAbort, { once: true });

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

export class UnsupportedCapabilityError extends Error {
    readonly scheme: ProjectScheme;
    readonly capability: ProjectCapability;

    constructor(scheme: ProjectScheme, capability: ProjectCapability) {
        super(`Project backend ${scheme} does not support ${capability}`);
        this.name = "UnsupportedCapabilityError";
        this.scheme = scheme;
        this.capability = capability;
    }
}

export class ProjectBackendDisposedError extends Error {
    constructor(scheme: ProjectScheme) {
        super(`Project backend ${scheme} is disposed`);
        this.name = "ProjectBackendDisposedError";
    }
}

export class ProjectBackendRegistryDisposedError extends Error {
    constructor() {
        super("Project backend registry is disposed");
        this.name = "ProjectBackendRegistryDisposedError";
    }
}

export class ProjectBackendNotRegisteredError extends Error {
    readonly scheme: ProjectScheme;

    constructor(scheme: ProjectScheme) {
        super(`No trusted project backend is registered for ${scheme}`);
        this.name = "ProjectBackendNotRegisteredError";
        this.scheme = scheme;
    }
}

export interface ProjectBackend {
    readonly scheme: ProjectScheme;
    readonly capabilities: ProjectCapabilities;
    files(location: ProjectLocation, request: ProjectBackendRequest, options?: ProjectBackendCallOptions): Promise<unknown>;
    watch(location: ProjectLocation, request: ProjectBackendRequest, options?: ProjectBackendCallOptions): Promise<unknown>;
    pty(location: ProjectLocation, request: ProjectBackendRequest, options?: ProjectBackendCallOptions): Promise<unknown>;
    lsp(location: ProjectLocation, request: ProjectBackendRequest, options?: ProjectBackendCallOptions): Promise<unknown>;
    git(location: ProjectLocation, request: ProjectBackendRequest, options?: ProjectBackendCallOptions): Promise<unknown>;
    tasks(location: ProjectLocation, request: ProjectBackendRequest, options?: ProjectBackendCallOptions): Promise<unknown>;
    dispose(): Promise<void>;
}

export type LocalProjectOperation = (
    location: LocalProjectLocation,
    request: ProjectBackendRequest,
    options: ProjectBackendCallOptions,
) => unknown | PromiseLike<unknown>;

export interface LocalProjectBackendOperations {
    readonly files?: LocalProjectOperation;
    readonly watch?: LocalProjectOperation;
    readonly pty?: LocalProjectOperation;
    readonly lsp?: LocalProjectOperation;
    readonly git?: LocalProjectOperation;
    readonly tasks?: LocalProjectOperation;
    readonly dispose?: () => void | PromiseLike<void>;
}

export class LocalProjectBackend implements ProjectBackend {
    readonly scheme = "local" as const;
    readonly capabilities: ProjectCapabilities;
    private readonly operations: LocalProjectBackendOperations;
    private disposed = false;
    private disposePromise: Promise<void> | null = null;

    constructor(operations: LocalProjectBackendOperations) {
        if (!isRecord(operations)) throw new TypeError("Local project operations must be an object");
        requireOnlyKeys(operations, [...PROJECT_CAPABILITY_NAMES, "dispose"], "local project operation");
        const copied: Record<string, LocalProjectOperation | (() => void | PromiseLike<void>)> = {};
        const enabled: ProjectCapability[] = [];
        for (const capability of PROJECT_CAPABILITY_NAMES) {
            const operation = operations[capability];
            if (operation === undefined) continue;
            if (typeof operation !== "function") throw new TypeError(`Local project operation ${capability} must be a function`);
            copied[capability] = operation as LocalProjectOperation;
            enabled.push(capability);
        }
        if (operations.dispose !== undefined) {
            if (typeof operations.dispose !== "function") throw new TypeError("Local project dispose operation must be a function");
            copied.dispose = operations.dispose as () => void | PromiseLike<void>;
        }
        this.operations = Object.freeze(copied) as LocalProjectBackendOperations;
        this.capabilities = createProjectCapabilities(enabled);
    }

    files(location: ProjectLocation, request: ProjectBackendRequest, options?: ProjectBackendCallOptions): Promise<unknown> {
        return this.invoke("files", location, request, options);
    }

    watch(location: ProjectLocation, request: ProjectBackendRequest, options?: ProjectBackendCallOptions): Promise<unknown> {
        return this.invoke("watch", location, request, options);
    }

    pty(location: ProjectLocation, request: ProjectBackendRequest, options?: ProjectBackendCallOptions): Promise<unknown> {
        return this.invoke("pty", location, request, options);
    }

    lsp(location: ProjectLocation, request: ProjectBackendRequest, options?: ProjectBackendCallOptions): Promise<unknown> {
        return this.invoke("lsp", location, request, options);
    }

    git(location: ProjectLocation, request: ProjectBackendRequest, options?: ProjectBackendCallOptions): Promise<unknown> {
        return this.invoke("git", location, request, options);
    }

    tasks(location: ProjectLocation, request: ProjectBackendRequest, options?: ProjectBackendCallOptions): Promise<unknown> {
        return this.invoke("tasks", location, request, options);
    }

    dispose(): Promise<void> {
        if (this.disposePromise) return this.disposePromise;
        this.disposed = true;
        const dispose = this.operations.dispose;
        this.disposePromise = dispose === undefined ? Promise.resolve() : runAbortable(undefined, dispose);
        return this.disposePromise;
    }

    private invoke(
        capability: ProjectCapability,
        locationInput: ProjectLocation,
        requestInput: ProjectBackendRequest,
        options: ProjectBackendCallOptions = {},
    ): Promise<unknown> {
        if (this.disposed) return Promise.reject(new ProjectBackendDisposedError(this.scheme));
        const operation = this.operations[capability];
        if (!operation) return Promise.reject(new UnsupportedCapabilityError(this.scheme, capability));

        let location: LocalProjectLocation;
        let request: ProjectBackendRequest;
        try {
            const validatedLocation = createProjectLocation(locationInput);
            if (validatedLocation.scheme !== "local") throw new TypeError("Local project backend requires a local location");
            location = validatedLocation;
            request = validateRequest(requestInput);
        } catch (error) {
            return Promise.reject(error);
        }
        const callOptions = Object.freeze({ ...(options.signal === undefined ? {} : { signal: options.signal }) });
        return runAbortable(options.signal, () => operation(location, request, callOptions));
    }
}

interface RegistryEntry {
    readonly backend: ProjectBackend;
    readonly capabilities: ProjectCapabilities;
    disposePromise: Promise<void> | null;
}

export interface ProjectBackendRegistration {
    readonly scheme: ProjectScheme;
    dispose(): Promise<void>;
}

export interface ProjectBackendRegistryOptions {
    readonly maxRegistrations?: number;
}

function requireBackend(backend: ProjectBackend): ProjectBackend {
    if (!isRecord(backend)) throw new TypeError("Project backend must be an object");
    if (backend.scheme !== "local" && backend.scheme !== "ssh") throw new TypeError("Project backend scheme must be local or ssh");
    copyCapabilities(backend.capabilities);
    for (const capability of PROJECT_CAPABILITY_NAMES) {
        if (typeof backend[capability] !== "function") throw new TypeError(`Project backend ${capability} method must be a function`);
    }
    if (typeof backend.dispose !== "function") throw new TypeError("Project backend dispose method must be a function");
    return backend;
}

export class ProjectBackendRegistry {
    private readonly registrations = new Map<ProjectScheme, RegistryEntry>();
    private readonly maxRegistrations: number;
    private disposed = false;
    private disposePromise: Promise<void> | null = null;

    constructor(options: ProjectBackendRegistryOptions = {}) {
        const maxRegistrations = options.maxRegistrations ?? PROJECT_BACKEND_LIMITS.defaultMaxRegistrations;
        if (!Number.isSafeInteger(maxRegistrations) || maxRegistrations < 1 || maxRegistrations > PROJECT_BACKEND_LIMITS.hardMaxRegistrations) {
            throw new RangeError(`Project backend registration limit must be from 1 through ${PROJECT_BACKEND_LIMITS.hardMaxRegistrations}`);
        }
        this.maxRegistrations = maxRegistrations;
    }

    get size(): number {
        return this.registrations.size;
    }

    /** Host composition roots register constructed backends; serialized/plugin declarations are never accepted here. */
    registerTrusted(backendInput: ProjectBackend): ProjectBackendRegistration {
        if (this.disposed) throw new ProjectBackendRegistryDisposedError();
        const backend = requireBackend(backendInput);
        if (this.registrations.has(backend.scheme)) throw new TypeError(`A project backend is already registered for ${backend.scheme}`);
        if (this.registrations.size >= this.maxRegistrations) {
            throw new RangeError(`Project backend registry cannot exceed ${this.maxRegistrations} registrations`);
        }
        const entry: RegistryEntry = { backend, capabilities: copyCapabilities(backend.capabilities), disposePromise: null };
        this.registrations.set(backend.scheme, entry);
        return Object.freeze({
            scheme: backend.scheme,
            dispose: () => this.disposeEntry(entry),
        });
    }

    resolve(locationInput: ProjectLocation): ProjectBackend {
        if (this.disposed) throw new ProjectBackendRegistryDisposedError();
        const location = createProjectLocation(locationInput);
        const entry = this.registrations.get(location.scheme);
        if (!entry) throw new ProjectBackendNotRegisteredError(location.scheme);
        return entry.backend;
    }

    files(location: ProjectLocation, request: ProjectBackendRequest, options?: ProjectBackendCallOptions): Promise<unknown> {
        return this.route("files", location, request, options);
    }

    watch(location: ProjectLocation, request: ProjectBackendRequest, options?: ProjectBackendCallOptions): Promise<unknown> {
        return this.route("watch", location, request, options);
    }

    pty(location: ProjectLocation, request: ProjectBackendRequest, options?: ProjectBackendCallOptions): Promise<unknown> {
        return this.route("pty", location, request, options);
    }

    lsp(location: ProjectLocation, request: ProjectBackendRequest, options?: ProjectBackendCallOptions): Promise<unknown> {
        return this.route("lsp", location, request, options);
    }

    git(location: ProjectLocation, request: ProjectBackendRequest, options?: ProjectBackendCallOptions): Promise<unknown> {
        return this.route("git", location, request, options);
    }

    tasks(location: ProjectLocation, request: ProjectBackendRequest, options?: ProjectBackendCallOptions): Promise<unknown> {
        return this.route("tasks", location, request, options);
    }

    dispose(): Promise<void> {
        if (this.disposePromise) return this.disposePromise;
        this.disposed = true;
        const entries = Array.from(this.registrations.values());
        this.registrations.clear();
        this.disposePromise = Promise.allSettled(entries.map((entry) => this.disposeEntry(entry))).then((results) => {
            const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
            if (failures.length > 0)
                throw new AggregateError(
                    failures.map((failure) => failure.reason),
                    "Project backend disposal failed",
                );
        });
        return this.disposePromise;
    }

    private route(
        capability: ProjectCapability,
        locationInput: ProjectLocation,
        requestInput: ProjectBackendRequest,
        options?: ProjectBackendCallOptions,
    ): Promise<unknown> {
        let location: ProjectLocation;
        let request: ProjectBackendRequest;
        let entry: RegistryEntry;
        try {
            if (this.disposed) throw new ProjectBackendRegistryDisposedError();
            location = createProjectLocation(locationInput);
            request = validateRequest(requestInput);
            const resolved = this.registrations.get(location.scheme);
            if (!resolved) throw new ProjectBackendNotRegisteredError(location.scheme);
            if (!resolved.capabilities[capability]) throw new UnsupportedCapabilityError(location.scheme, capability);
            entry = resolved;
        } catch (error) {
            return Promise.reject(error);
        }
        return runAbortable(options?.signal, () => entry.backend[capability](location, request, options));
    }

    private disposeEntry(entry: RegistryEntry): Promise<void> {
        if (entry.disposePromise) return entry.disposePromise;
        if (this.registrations.get(entry.backend.scheme) === entry) this.registrations.delete(entry.backend.scheme);
        entry.disposePromise = runAbortable(undefined, () => entry.backend.dispose());
        return entry.disposePromise;
    }
}

import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { git, type CaptureGitCheckpointOptions, type ForkGitCheckpointOptions, type GitCheckpoint, type GitWorktree } from "../../api/git";
import { IS_WINDOWS } from "../../lib/platform";

export const CHECKPOINT_PANEL_LIMITS = Object.freeze({
    maxCheckpoints: 256,
    maxAgentBytes: 80,
    maxLabelBytes: 160,
    maxPathBytes: 4_096,
    maxBranchBytes: 255,
    maxRenderedDiffBytes: 256 * 1_024,
    maxErrorCharacters: 240,
});

export interface CheckpointPanelApi {
    checkpointCapture(repo: string, options: CaptureGitCheckpointOptions): Promise<GitCheckpoint>;
    checkpoints(repo: string, agentId: string): Promise<GitCheckpoint[]>;
    checkpointDiff(repo: string, agentId: string, checkpointId: string, baseCheckpointId?: string | null): Promise<string>;
    checkpointDelete(repo: string, agentId: string, checkpointId: string): Promise<void>;
    checkpointFork(repo: string, options: ForkGitCheckpointOptions): Promise<GitWorktree>;
}

export interface CheckpointPanelProps {
    readonly repo: string;
    readonly initialAgentNamespace: string;
    readonly api?: CheckpointPanelApi;
    /** Required for deletion. Missing confirmation always fails closed. */
    readonly confirmDelete?: (checkpoint: GitCheckpoint) => boolean | PromiseLike<boolean>;
    readonly onForked?: (worktree: GitWorktree) => void;
    /** Deterministic tests may inject an ID; every result is still validated. */
    readonly createCheckpointId?: () => string;
}

interface RenderedDiff {
    readonly text: string;
    readonly truncated: boolean;
}

type MutationKind = "capture" | "delete" | "fork";

const COMPONENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
const OID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;
const UTF8_ENCODER = new TextEncoder();
let generatedIdSequence = 0;

function containsControlCharacter(value: string): boolean {
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code <= 31 || (code >= 127 && code <= 159)) return true;
    }
    return false;
}

function utf8LengthWithin(value: string, limit: number): boolean {
    if (value.length > limit) return false;
    return UTF8_ENCODER.encode(value).byteLength <= limit;
}

function requireRepository(value: unknown): string {
    if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.trim().length === 0 ||
        !utf8LengthWithin(value, CHECKPOINT_PANEL_LIMITS.maxPathBytes) ||
        containsControlCharacter(value)
    ) {
        throw new TypeError("Repository path must be bounded non-blank text");
    }
    return value;
}

function requireComponent(kind: "agent namespace" | "checkpoint ID", value: unknown): string {
    if (typeof value !== "string" || !utf8LengthWithin(value, CHECKPOINT_PANEL_LIMITS.maxAgentBytes) || !COMPONENT_PATTERN.test(value)) {
        throw new TypeError(`${kind} must start with a letter or number and contain only letters, numbers, '-' or '_'`);
    }
    return value;
}

function requireLabel(value: unknown): string {
    if (typeof value !== "string") throw new TypeError("Checkpoint label must be text");
    const trimmed = value.trim();
    if (trimmed.length === 0 || !utf8LengthWithin(trimmed, CHECKPOINT_PANEL_LIMITS.maxLabelBytes) || containsControlCharacter(trimmed)) {
        throw new TypeError(`Checkpoint label must be 1-${CHECKPOINT_PANEL_LIMITS.maxLabelBytes} UTF-8 bytes without control characters`);
    }
    return trimmed;
}

function pathComponents(value: string): string[] {
    return value.split(IS_WINDOWS ? /[\\/]/u : "/");
}

function requireForkPath(value: unknown): string {
    if (typeof value !== "string") throw new TypeError("Fork path must be text");
    const path = value;
    if (
        path.length === 0 ||
        path !== path.trim() ||
        !utf8LengthWithin(path, CHECKPOINT_PANEL_LIMITS.maxPathBytes) ||
        containsControlCharacter(path)
    ) {
        throw new TypeError(`Fork path must be 1-${CHECKPOINT_PANEL_LIMITS.maxPathBytes} UTF-8 bytes without control characters`);
    }
    const absolute = IS_WINDOWS ? /^[A-Za-z]:[\\/]/u.test(path) || /^\\\\[^\\]+\\[^\\]+/u.test(path) : path.startsWith("/");
    if (!absolute) throw new TypeError("Fork path must be absolute");
    const components = pathComponents(path);
    if (components.some((component) => component === "." || component === "..")) {
        throw new TypeError("Fork path must not contain '.' or '..' components");
    }
    const isRoot = IS_WINDOWS ? /^[A-Za-z]:[\\/]*$/u.test(path) : /^\/+$/u.test(path);
    const isUncRoot = IS_WINDOWS && /^\\\\[^\\/]+[\\/]+[^\\/]+[\\/]*$/u.test(path);
    if (isRoot || isUncRoot) throw new TypeError("Fork path cannot be a filesystem root");
    return path;
}

function requireBranch(value: unknown): string {
    if (typeof value !== "string") throw new TypeError("Fork branch must be text");
    const branch = value.trim();
    const invalidSegment = branch.split("/").some((segment) => segment.length === 0 || segment.startsWith(".") || segment.endsWith(".lock"));
    if (
        !utf8LengthWithin(branch, CHECKPOINT_PANEL_LIMITS.maxBranchBytes) ||
        !BRANCH_PATTERN.test(branch) ||
        branch.startsWith("-") ||
        branch.endsWith(".") ||
        branch.endsWith("/") ||
        branch.includes("..") ||
        branch.includes("@{") ||
        invalidSegment
    ) {
        throw new TypeError("Fork branch must be a bounded, safe Git branch name");
    }
    return branch;
}

function ownDataProperty(value: object, key: string): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) throw new TypeError("Checkpoint response contains an invalid field");
    return descriptor.value;
}

function boundedResponseString(value: unknown, maxBytes: number, nullable = false): string | null {
    if (nullable && value === null) return null;
    if (typeof value !== "string" || value.length === 0 || !utf8LengthWithin(value, maxBytes) || containsControlCharacter(value)) {
        throw new TypeError("Checkpoint response contains invalid text");
    }
    return value;
}

function boundedCount(value: unknown): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw new TypeError("Checkpoint response contains an invalid count");
    }
    return value;
}

function normalizeCheckpoint(value: unknown): GitCheckpoint {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("Checkpoint response must be an object");
    const id = requireComponent("checkpoint ID", ownDataProperty(value, "id"));
    const reference = boundedResponseString(ownDataProperty(value, "ref"), 512)!;
    const commit = boundedResponseString(ownDataProperty(value, "commit"), 64)!;
    const head = boundedResponseString(ownDataProperty(value, "head"), 64, true);
    if (!OID_PATTERN.test(commit) || (head !== null && !OID_PATTERN.test(head)))
        throw new TypeError("Checkpoint response contains an invalid Git object ID");
    const createdAt = ownDataProperty(value, "createdAt");
    if (typeof createdAt !== "number" || !Number.isSafeInteger(createdAt) || createdAt < 0 || createdAt > 8_640_000_000_000_000) {
        throw new TypeError("Checkpoint response contains an invalid timestamp");
    }
    return Object.freeze({
        id,
        ref: reference,
        commit,
        head,
        createdAt,
        label: requireLabel(ownDataProperty(value, "label")),
        fileCount: boundedCount(ownDataProperty(value, "fileCount")),
        additionCount: boundedCount(ownDataProperty(value, "additionCount")),
        deletionCount: boundedCount(ownDataProperty(value, "deletionCount")),
    });
}

function normalizeCheckpointList(value: unknown): readonly GitCheckpoint[] {
    if (!Array.isArray(value) || value.length > CHECKPOINT_PANEL_LIMITS.maxCheckpoints) {
        throw new TypeError(`Checkpoint list must contain at most ${CHECKPOINT_PANEL_LIMITS.maxCheckpoints} items`);
    }
    const seen = new Set<string>();
    const checkpoints = value.map((item) => {
        const checkpoint = normalizeCheckpoint(item);
        if (seen.has(checkpoint.id)) throw new TypeError("Checkpoint list contains duplicate IDs");
        seen.add(checkpoint.id);
        return checkpoint;
    });
    checkpoints.sort((left, right) => right.createdAt - left.createdAt || (left.id < right.id ? 1 : left.id > right.id ? -1 : 0));
    return Object.freeze(checkpoints);
}

export function capCheckpointDiffForRender(value: unknown): RenderedDiff {
    if (typeof value !== "string") throw new TypeError("Checkpoint diff response must be text");
    const target = new Uint8Array(CHECKPOINT_PANEL_LIMITS.maxRenderedDiffBytes);
    const { read } = UTF8_ENCODER.encodeInto(value, target);
    if (read === value.length) return Object.freeze({ text: value, truncated: false });
    return Object.freeze({
        text: `${value.slice(0, read)}\n\n… diff truncated to ${CHECKPOINT_PANEL_LIMITS.maxRenderedDiffBytes / 1_024} KiB for rendering …`,
        truncated: true,
    });
}

export function sanitizeCheckpointError(error: unknown): string {
    let raw = "Checkpoint operation failed";
    if (typeof error === "string") raw = error;
    else if ((typeof error === "object" || typeof error === "function") && error !== null) {
        try {
            const descriptor = Object.getOwnPropertyDescriptor(error, "message");
            if (descriptor && "value" in descriptor && typeof descriptor.value === "string") raw = descriptor.value;
        } catch {
            // Opaque errors are never enumerated or stringified.
        }
    }

    const limit = CHECKPOINT_PANEL_LIMITS.maxErrorCharacters;
    const scanLimit = Math.min(raw.length, limit * 8);
    let sanitized = "";
    let pendingSpace = false;
    for (let index = 0; index < scanLimit && sanitized.length < limit;) {
        const code = raw.codePointAt(index) ?? 0;
        const character = String.fromCodePoint(code);
        index += character.length;
        if (code === 27) {
            while (index < scanLimit) {
                const terminal = raw.charCodeAt(index);
                index += 1;
                if ((terminal >= 64 && terminal <= 126) || terminal === 7) break;
            }
            pendingSpace = sanitized.length > 0;
            continue;
        }
        if (code <= 31 || (code >= 127 && code <= 159) || /\s/u.test(character)) {
            pendingSpace = sanitized.length > 0;
            continue;
        }
        if (pendingSpace && sanitized.length < limit) sanitized += " ";
        pendingSpace = false;
        if (sanitized.length + character.length > limit) break;
        sanitized += character;
    }
    return sanitized.trim() || "Checkpoint operation failed";
}

function callAsPromise<Value>(operation: () => Value | PromiseLike<Value>): Promise<Value> {
    try {
        return Promise.resolve(operation());
    } catch (error) {
        return Promise.reject(error);
    }
}

function contextKey(repo: string, agentId: string): string {
    return JSON.stringify([repo, agentId]);
}

function defaultCheckpointId(): string {
    generatedIdSequence = generatedIdSequence >= Number.MAX_SAFE_INTEGER ? 1 : generatedIdSequence + 1;
    const timestamp = Math.max(0, Math.floor(Date.now())).toString(36);
    const random = globalThis.crypto?.randomUUID?.().replaceAll("-", "").slice(0, 12) ?? generatedIdSequence.toString(36);
    return `cp-${timestamp}-${random}`;
}

function formatCreatedAt(createdAt: number): string {
    return new Date(createdAt).toISOString().replace("T", " ").replace(".000Z", "Z");
}

export function CheckpointPanel({
    repo,
    initialAgentNamespace,
    api = git,
    confirmDelete,
    onForked,
    createCheckpointId = defaultCheckpointId,
}: CheckpointPanelProps) {
    const titleId = useId();
    const mountedRef = useRef(true);
    const refreshGenerationRef = useRef(0);
    const diffGenerationRef = useRef(0);
    const activeRefreshKeyRef = useRef<string | null>(null);
    const mutationRef = useRef<object | null>(null);
    const [agentInput, setAgentInput] = useState(initialAgentNamespace);
    const [activeAgent, setActiveAgent] = useState<string | null>(null);
    const [checkpoints, setCheckpoints] = useState<readonly GitCheckpoint[]>(Object.freeze([]));
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [comparePrevious, setComparePrevious] = useState(false);
    const [label, setLabel] = useState("");
    const [forkPath, setForkPath] = useState("");
    const [forkBranch, setForkBranch] = useState("");
    const [diff, setDiff] = useState("");
    const [diffTruncated, setDiffTruncated] = useState(false);
    const [diffLoading, setDiffLoading] = useState(false);
    const [refreshingKey, setRefreshingKey] = useState<string | null>(null);
    const [mutation, setMutation] = useState<MutationKind | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [diffError, setDiffError] = useState<string | null>(null);
    const [status, setStatus] = useState("Loading checkpoints…");

    const activeContext = activeAgent === null ? null : contextKey(repo, activeAgent);
    const contextRef = useRef(activeContext);
    contextRef.current = activeContext;

    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            refreshGenerationRef.current += 1;
            diffGenerationRef.current += 1;
            activeRefreshKeyRef.current = null;
        };
    }, []);

    const refresh = useCallback(
        async (targetRepo: string, targetAgentInput: string, force = false): Promise<void> => {
            let validRepo: string;
            let agentId: string;
            try {
                validRepo = requireRepository(targetRepo);
                agentId = requireComponent("agent namespace", targetAgentInput);
            } catch (validationError) {
                if (mountedRef.current) setError(sanitizeCheckpointError(validationError));
                return;
            }
            const key = contextKey(validRepo, agentId);
            if (!force && activeRefreshKeyRef.current === key) return;
            const generation = refreshGenerationRef.current + 1;
            refreshGenerationRef.current = generation;
            activeRefreshKeyRef.current = key;
            setRefreshingKey(key);
            setError(null);
            setStatus("Loading checkpoints…");
            try {
                const response = await callAsPromise(() => api.checkpoints(validRepo, agentId));
                const next = normalizeCheckpointList(response);
                if (!mountedRef.current || generation !== refreshGenerationRef.current) return;
                diffGenerationRef.current += 1;
                setActiveAgent(agentId);
                setCheckpoints(next);
                setSelectedId((current) => (current && next.some((checkpoint) => checkpoint.id === current) ? current : (next[0]?.id ?? null)));
                setDiff("");
                setDiffTruncated(false);
                setDiffLoading(false);
                setDiffError(null);
                setStatus(
                    next.length === 0 ? "No checkpoints in this namespace." : `${next.length} checkpoint${next.length === 1 ? "" : "s"} loaded.`,
                );
            } catch (refreshError) {
                if (!mountedRef.current || generation !== refreshGenerationRef.current) return;
                setError(`Could not refresh checkpoints: ${sanitizeCheckpointError(refreshError)}`);
                setStatus("Checkpoint refresh failed.");
            } finally {
                if (mountedRef.current && generation === refreshGenerationRef.current) {
                    activeRefreshKeyRef.current = null;
                    setRefreshingKey(null);
                }
            }
        },
        [api],
    );

    useEffect(() => {
        setAgentInput(initialAgentNamespace);
        setActiveAgent(null);
        setCheckpoints(Object.freeze([]));
        setSelectedId(null);
        setDiff("");
        setDiffTruncated(false);
        setDiffError(null);
        diffGenerationRef.current += 1;
        void refresh(repo, initialAgentNamespace, true);
        return () => {
            refreshGenerationRef.current += 1;
            diffGenerationRef.current += 1;
            activeRefreshKeyRef.current = null;
        };
    }, [api, initialAgentNamespace, refresh, repo]);

    const selectedIndex = useMemo(() => checkpoints.findIndex((checkpoint) => checkpoint.id === selectedId), [checkpoints, selectedId]);
    const selected = selectedIndex >= 0 ? checkpoints[selectedIndex]! : null;
    const previousId = selectedIndex >= 0 ? checkpoints[selectedIndex + 1]?.id : undefined;
    const baseCheckpointId = comparePrevious ? previousId : undefined;

    useEffect(() => {
        const generation = diffGenerationRef.current + 1;
        diffGenerationRef.current = generation;
        if (!selected || !activeAgent) {
            setDiff("");
            setDiffTruncated(false);
            setDiffLoading(false);
            setDiffError(null);
            return;
        }
        setDiff("");
        setDiffTruncated(false);
        setDiffError(null);
        setDiffLoading(true);
        void callAsPromise(() => api.checkpointDiff(repo, activeAgent, selected.id, baseCheckpointId ?? null)).then(
            (response) => {
                if (!mountedRef.current || generation !== diffGenerationRef.current) return;
                try {
                    const rendered = capCheckpointDiffForRender(response);
                    setDiff(rendered.text);
                    setDiffTruncated(rendered.truncated);
                } catch (diffError) {
                    setDiffError(`Could not load checkpoint diff: ${sanitizeCheckpointError(diffError)}`);
                }
                setDiffLoading(false);
            },
            (diffError) => {
                if (!mountedRef.current || generation !== diffGenerationRef.current) return;
                setDiffLoading(false);
                setDiffError(`Could not load checkpoint diff: ${sanitizeCheckpointError(diffError)}`);
            },
        );
    }, [activeAgent, api, baseCheckpointId, repo, selected]);

    const beginMutation = (kind: MutationKind): object | null => {
        if (mutationRef.current) return null;
        const token = Object.freeze({ kind });
        mutationRef.current = token;
        setMutation(kind);
        setError(null);
        return token;
    };

    const finishMutation = (token: object): void => {
        if (mutationRef.current !== token) return;
        mutationRef.current = null;
        if (mountedRef.current) setMutation(null);
    };

    const invalidateRefresh = (): void => {
        refreshGenerationRef.current += 1;
        activeRefreshKeyRef.current = null;
        setRefreshingKey(null);
    };

    const capture = async (event: FormEvent): Promise<void> => {
        event.preventDefault();
        if (!activeAgent || agentInput !== activeAgent) {
            setError("Load this agent namespace before capturing a checkpoint.");
            return;
        }
        let checkpointLabel: string;
        let checkpointId: string;
        try {
            checkpointLabel = requireLabel(label);
            checkpointId = requireComponent("checkpoint ID", createCheckpointId());
        } catch (validationError) {
            setError(sanitizeCheckpointError(validationError));
            return;
        }
        const token = beginMutation("capture");
        if (!token) return;
        const operationContext = activeContext;
        invalidateRefresh();
        try {
            const response = await callAsPromise(() => api.checkpointCapture(repo, { agentId: activeAgent, checkpointId, label: checkpointLabel }));
            const checkpoint = normalizeCheckpoint(response);
            if (mountedRef.current && contextRef.current === operationContext) {
                diffGenerationRef.current += 1;
                setCheckpoints((current) =>
                    Object.freeze(
                        [checkpoint, ...current.filter((candidate) => candidate.id !== checkpoint.id)].slice(
                            0,
                            CHECKPOINT_PANEL_LIMITS.maxCheckpoints,
                        ),
                    ),
                );
                setSelectedId(checkpoint.id);
                setLabel("");
                setStatus(`Captured checkpoint ${checkpoint.label}.`);
            }
        } catch (captureError) {
            if (mountedRef.current && contextRef.current === operationContext) {
                setError(`Could not capture checkpoint: ${sanitizeCheckpointError(captureError)}`);
            }
        } finally {
            finishMutation(token);
        }
    };

    const deleteSelected = async (): Promise<void> => {
        if (!selected) return;
        if (!activeAgent || agentInput !== activeAgent) {
            setError("Load this agent namespace before deleting a checkpoint.");
            return;
        }
        if (!confirmDelete) {
            setError("Checkpoint deletion requires an explicit confirmation callback.");
            return;
        }
        const token = beginMutation("delete");
        if (!token) return;
        const operationContext = activeContext;
        try {
            const confirmed = await callAsPromise(() => confirmDelete(selected));
            if (!confirmed) {
                if (mountedRef.current && contextRef.current === operationContext) setStatus("Checkpoint deletion cancelled.");
                return;
            }
            invalidateRefresh();
            await callAsPromise(() => api.checkpointDelete(repo, activeAgent!, selected.id));
            if (mountedRef.current && contextRef.current === operationContext) {
                const remaining = checkpoints.filter((checkpoint) => checkpoint.id !== selected.id);
                diffGenerationRef.current += 1;
                setCheckpoints(Object.freeze(remaining));
                setSelectedId(remaining[0]?.id ?? null);
                setStatus(`Deleted checkpoint ${selected.label}.`);
            }
        } catch (deleteError) {
            if (mountedRef.current && contextRef.current === operationContext) {
                setError(`Could not delete checkpoint: ${sanitizeCheckpointError(deleteError)}`);
            }
        } finally {
            finishMutation(token);
        }
    };

    const forkSelected = async (event: FormEvent): Promise<void> => {
        event.preventDefault();
        if (!selected || !activeAgent) return;
        if (agentInput !== activeAgent) {
            setError("Load this agent namespace before forking a checkpoint.");
            return;
        }
        let path: string;
        let branch: string;
        try {
            path = requireForkPath(forkPath);
            branch = requireBranch(forkBranch);
        } catch (validationError) {
            setError(sanitizeCheckpointError(validationError));
            return;
        }
        const token = beginMutation("fork");
        if (!token) return;
        const operationContext = activeContext;
        try {
            const worktree = await callAsPromise(() => api.checkpointFork(repo, { agentId: activeAgent, checkpointId: selected.id, path, branch }));
            if (mountedRef.current && contextRef.current === operationContext) {
                setStatus(`Forked ${selected.label} to ${path}.`);
            }
            if (mountedRef.current) {
                try {
                    onForked?.(worktree);
                } catch {
                    // A consumer callback cannot turn a successful fork into a
                    // duplicate retry or expose its opaque exception.
                }
            }
        } catch (forkError) {
            if (mountedRef.current && contextRef.current === operationContext) {
                setError(`Could not fork checkpoint: ${sanitizeCheckpointError(forkError)}`);
            }
        } finally {
            finishMutation(token);
        }
    };

    let requestedRefreshKey: string | null = null;
    try {
        requestedRefreshKey = contextKey(requireRepository(repo), requireComponent("agent namespace", agentInput));
    } catch {
        // The refresh handler owns the accessible validation error.
    }
    const refreshingCurrentNamespace = requestedRefreshKey !== null && refreshingKey === requestedRefreshKey;
    const namespaceReady = activeAgent !== null && agentInput === activeAgent;
    const controlsBusy = mutation !== null;

    return (
        <section className="git-panel focused" aria-labelledby={titleId} aria-busy={refreshingKey !== null || diffLoading || controlsBusy}>
            <div className="git-panel-head">
                <span className="git-panel-n" aria-hidden="true">
                    C
                </span>
                <span className="git-panel-label" id={titleId}>
                    Checkpoints
                </span>
                <span className="git-panel-pill">{checkpoints.length}</span>
                <span className="git-head-actions">
                    <button
                        type="button"
                        className="git-hbtn"
                        disabled={refreshingCurrentNamespace || controlsBusy}
                        onClick={() => void refresh(repo, agentInput)}>
                        {refreshingCurrentNamespace ? "refreshing…" : "refresh"}
                    </button>
                </span>
            </div>

            <div className="git-panel-body">
                <div className="git-commit-bar">
                    <label>
                        <span className="git-panel-label">Agent namespace</span>
                        <input
                            className="git-commit-input"
                            aria-label="Agent namespace"
                            value={agentInput}
                            maxLength={CHECKPOINT_PANEL_LIMITS.maxAgentBytes}
                            disabled={controlsBusy}
                            autoCapitalize="off"
                            autoCorrect="off"
                            spellCheck={false}
                            onChange={(event) => setAgentInput(event.target.value)}
                            onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                    event.preventDefault();
                                    void refresh(repo, agentInput);
                                }
                            }}
                        />
                    </label>
                </div>

                <form className="git-commit-bar" onSubmit={(event) => void capture(event)}>
                    <label>
                        <span className="git-panel-label">Checkpoint label</span>
                        <input
                            className="git-commit-input"
                            aria-label="Checkpoint label"
                            value={label}
                            maxLength={CHECKPOINT_PANEL_LIMITS.maxLabelBytes}
                            disabled={controlsBusy || !namespaceReady}
                            onChange={(event) => setLabel(event.target.value)}
                        />
                    </label>
                    <button className="git-cp-commit" type="submit" disabled={controlsBusy || !namespaceReady || label.trim().length === 0}>
                        {mutation === "capture" ? "capturing…" : "capture"}
                    </button>
                </form>

                {error && (
                    <div className="git-empty error" role="alert">
                        {error}
                    </div>
                )}
                {diffError && (
                    <div className="git-empty error" role="alert">
                        {diffError}
                    </div>
                )}
                <div className="git-empty" role="status" aria-live="polite">
                    {status}
                </div>

                <div role="list" aria-label="Checkpoints">
                    {checkpoints.map((checkpoint) => (
                        <div role="listitem" key={checkpoint.id}>
                            <button
                                type="button"
                                className={`git-row${selectedId === checkpoint.id ? " sel" : ""}`}
                                style={{ width: "100%", textAlign: "left" }}
                                disabled={controlsBusy || !namespaceReady}
                                aria-pressed={selectedId === checkpoint.id}
                                aria-label={`Select checkpoint ${checkpoint.label}`}
                                title={`${formatCreatedAt(checkpoint.createdAt)} · ${checkpoint.commit.slice(0, 12)}`}
                                onClick={() => {
                                    diffGenerationRef.current += 1;
                                    setSelectedId(checkpoint.id);
                                }}>
                                <span className="gb-dot cur" aria-hidden="true" />
                                <span className="git-path">{checkpoint.label}</span>
                                <span className="git-row-hint">
                                    {checkpoint.fileCount} files · +{checkpoint.additionCount} −{checkpoint.deletionCount}
                                </span>
                            </button>
                        </div>
                    ))}
                </div>
                {!refreshingCurrentNamespace && checkpoints.length === 0 && <div className="git-empty">No checkpoints.</div>}

                {selected && (
                    <div className="git-commit-panel">
                        <div className="git-panel-head">
                            <span className="git-panel-label">Review</span>
                            <span className="git-panel-pill">{selected.id}</span>
                            <span className="git-head-actions">
                                <button
                                    type="button"
                                    className="git-hbtn danger"
                                    disabled={controlsBusy || !namespaceReady || !confirmDelete}
                                    title={confirmDelete ? "Delete selected checkpoint" : "A confirmation callback is required to delete"}
                                    onClick={() => void deleteSelected()}>
                                    {mutation === "delete" ? "deleting…" : "delete"}
                                </button>
                            </span>
                        </div>
                        <label className="git-empty">
                            <input
                                type="checkbox"
                                checked={comparePrevious && previousId !== undefined}
                                disabled={controlsBusy || !namespaceReady || previousId === undefined}
                                onChange={(event) => {
                                    diffGenerationRef.current += 1;
                                    setComparePrevious(event.target.checked);
                                }}
                            />{" "}
                            Compare with previous checkpoint
                        </label>
                        {diffLoading ? (
                            <div className="git-empty">Loading checkpoint diff…</div>
                        ) : (
                            <pre className="git-output" tabIndex={0} aria-label="Checkpoint diff">
                                {diff || "No changes in this checkpoint."}
                            </pre>
                        )}
                        {diffTruncated && <div className="git-empty">The rendered diff was capped; the checkpoint itself is unchanged.</div>}

                        <form className="git-commit-bar" onSubmit={(event) => void forkSelected(event)}>
                            <label>
                                <span className="git-panel-label">Absolute fork path</span>
                                <input
                                    className="git-commit-input"
                                    aria-label="Fork path"
                                    value={forkPath}
                                    maxLength={CHECKPOINT_PANEL_LIMITS.maxPathBytes}
                                    disabled={controlsBusy || !namespaceReady}
                                    autoCapitalize="off"
                                    autoCorrect="off"
                                    spellCheck={false}
                                    onChange={(event) => setForkPath(event.target.value)}
                                />
                            </label>
                            <label>
                                <span className="git-panel-label">New branch</span>
                                <input
                                    className="git-commit-input"
                                    aria-label="Fork branch"
                                    value={forkBranch}
                                    maxLength={CHECKPOINT_PANEL_LIMITS.maxBranchBytes}
                                    disabled={controlsBusy || !namespaceReady}
                                    autoCapitalize="off"
                                    autoCorrect="off"
                                    spellCheck={false}
                                    onChange={(event) => setForkBranch(event.target.value)}
                                />
                            </label>
                            <button
                                className="git-cp-commit"
                                type="submit"
                                disabled={controlsBusy || !namespaceReady || forkPath.length === 0 || forkBranch.length === 0}>
                                {mutation === "fork" ? "forking…" : "fork checkpoint"}
                            </button>
                        </form>
                    </div>
                )}
            </div>
        </section>
    );
}

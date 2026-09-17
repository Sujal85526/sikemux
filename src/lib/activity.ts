/**
 * A bounded record of what the interface was doing, kept so a frozen window can
 * be explained afterwards. Every entry is a name, a duration, or a count: no
 * arguments, results, terminal text, or DOM contents are ever retained.
 */

export const UI_ACTIVITY_LIMITS = Object.freeze({
    /** Entries per array in the report sent to the native side. */
    maxEntries: 32,
    maxStringLength: 200,
    /** Commands tracked at once; beyond this a call is counted but not named. */
    maxInflight: 64,
});

export interface UiActivityInflight {
    readonly command: string;
    readonly ageMs: number;
}

export interface UiActivityRecent {
    readonly command: string;
    readonly ms: number;
    readonly ok: boolean;
}

export interface UiActivityInteraction {
    readonly kind: string;
    readonly ageMs: number;
}

export interface UiActivityRejection {
    readonly message: string;
    readonly count: number;
}

export interface UiActivityReport {
    readonly atMs: number;
    readonly inflight: UiActivityInflight[];
    readonly recent: UiActivityRecent[];
    readonly focusPane: string | null;
    readonly interactions: UiActivityInteraction[];
    readonly rejections: UiActivityRejection[];
}

export interface UiActivitySources {
    readonly focusPane?: () => string | null;
    readonly rejections?: () => readonly UiActivityRejection[];
}

export interface UiActivityTrackerOptions {
    /** Monotonic clock used for ages and durations. */
    readonly now?: () => number;
    /** Wall clock stamped on the report so the native side can line it up. */
    readonly wallClock?: () => number;
    readonly visible?: () => boolean;
    readonly capacity?: number;
    readonly maxInflight?: number;
}

/** The ticket a caller gets when the tracker had no room to name its command. */
export const UNTRACKED_COMMAND = 0;

const NO_REJECTIONS: readonly UiActivityRejection[] = Object.freeze([]);

function defaultClock(): number {
    if (typeof performance !== "undefined" && typeof performance.now === "function") return performance.now();
    return Date.now();
}

function defaultVisible(): boolean {
    return typeof document === "undefined" || !document.hidden;
}

function requireCapacity(name: string, value: number): number {
    if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
    return value;
}

function clampText(value: string): string {
    return value.length > UI_ACTIVITY_LIMITS.maxStringLength ? value.slice(0, UI_ACTIVITY_LIMITS.maxStringLength) : value;
}

function elapsed(from: number, to: number): number {
    return to > from ? to - from : 0;
}

interface InflightCommand {
    readonly command: string;
    readonly startedAt: number;
}

export class UiActivityTracker {
    private readonly now: () => number;
    private readonly wallClock: () => number;
    private readonly visible: () => boolean;
    private readonly capacity: number;
    private readonly maxInflight: number;

    private readonly inflight = new Map<number, InflightCommand>();
    private ticketSequence = 0;
    private droppedInflight = 0;

    private readonly recentCommand: string[];
    private readonly recentMs: Float64Array;
    private readonly recentOk: Uint8Array;
    private recentNext = 0;
    private recentCount = 0;

    private readonly interactionKind: string[];
    private readonly interactionAt: Float64Array;
    private interactionNext = 0;
    private interactionCount = 0;

    private sources: UiActivitySources = {};

    constructor(options: UiActivityTrackerOptions = {}) {
        this.now = options.now ?? defaultClock;
        this.wallClock = options.wallClock ?? (() => Date.now());
        this.visible = options.visible ?? defaultVisible;
        this.capacity = requireCapacity("activity capacity", options.capacity ?? UI_ACTIVITY_LIMITS.maxEntries);
        this.maxInflight = requireCapacity("activity maxInflight", options.maxInflight ?? UI_ACTIVITY_LIMITS.maxInflight);
        this.recentCommand = new Array<string>(this.capacity).fill("");
        this.recentMs = new Float64Array(this.capacity);
        this.recentOk = new Uint8Array(this.capacity);
        this.interactionKind = new Array<string>(this.capacity).fill("");
        this.interactionAt = new Float64Array(this.capacity);
    }

    get inflightCount(): number {
        return this.inflight.size;
    }

    get droppedInflightCount(): number {
        return this.droppedInflight;
    }

    setSources(sources: UiActivitySources): void {
        this.sources = { ...this.sources, ...sources };
    }

    /** Start tracking one command. The returned ticket ends it, exactly once. */
    beginCommand(command: string): number {
        if (typeof command !== "string" || command.length === 0) return UNTRACKED_COMMAND;
        if (this.inflight.size >= this.maxInflight) {
            this.droppedInflight += 1;
            return UNTRACKED_COMMAND;
        }
        this.ticketSequence += 1;
        if (this.ticketSequence >= Number.MAX_SAFE_INTEGER) this.ticketSequence = 1;
        this.inflight.set(this.ticketSequence, { command, startedAt: this.now() });
        return this.ticketSequence;
    }

    endCommand(ticket: number, ok: boolean): void {
        if (ticket === UNTRACKED_COMMAND) return;
        const started = this.inflight.get(ticket);
        if (!started) return;
        this.inflight.delete(ticket);
        const slot = this.recentNext;
        this.recentCommand[slot] = started.command;
        this.recentMs[slot] = elapsed(started.startedAt, this.now());
        this.recentOk[slot] = ok ? 1 : 0;
        this.recentNext = (slot + 1) % this.capacity;
        if (this.recentCount < this.capacity) this.recentCount += 1;
    }

    recordInteraction(kind: string): void {
        if (typeof kind !== "string" || kind.length === 0) return;
        const slot = this.interactionNext;
        this.interactionKind[slot] = kind;
        this.interactionAt[slot] = this.now();
        this.interactionNext = (slot + 1) % this.capacity;
        if (this.interactionCount < this.capacity) this.interactionCount += 1;
    }

    /** The report to send, or null while nobody is looking at the window. */
    report(): UiActivityReport | null {
        return this.visible() ? this.snapshot() : null;
    }

    /** Newest first, so a truncated list still holds what just happened. */
    snapshot(): UiActivityReport {
        const now = this.now();
        return {
            atMs: this.wallClock(),
            inflight: this.readInflight(now),
            recent: this.readRecent(),
            focusPane: this.readFocusPane(),
            interactions: this.readInteractions(now),
            rejections: this.readRejections(),
        };
    }

    reset(): void {
        this.inflight.clear();
        this.droppedInflight = 0;
        this.recentCommand.fill("");
        this.recentMs.fill(0);
        this.recentOk.fill(0);
        this.recentNext = 0;
        this.recentCount = 0;
        this.interactionKind.fill("");
        this.interactionAt.fill(0);
        this.interactionNext = 0;
        this.interactionCount = 0;
    }

    /** Oldest first: the call that has been outstanding longest explains a stall. */
    private readInflight(now: number): UiActivityInflight[] {
        const entries: UiActivityInflight[] = [];
        for (const started of this.inflight.values()) {
            if (entries.length >= UI_ACTIVITY_LIMITS.maxEntries) break;
            entries.push({ command: clampText(started.command), ageMs: elapsed(started.startedAt, now) });
        }
        return entries;
    }

    private readRecent(): UiActivityRecent[] {
        const entries: UiActivityRecent[] = [];
        for (let index = 0; index < this.recentCount && entries.length < UI_ACTIVITY_LIMITS.maxEntries; index += 1) {
            const slot = (this.recentNext - 1 - index + this.capacity * 2) % this.capacity;
            entries.push({ command: clampText(this.recentCommand[slot]), ms: this.recentMs[slot], ok: this.recentOk[slot] === 1 });
        }
        return entries;
    }

    private readInteractions(now: number): UiActivityInteraction[] {
        const entries: UiActivityInteraction[] = [];
        for (let index = 0; index < this.interactionCount && entries.length < UI_ACTIVITY_LIMITS.maxEntries; index += 1) {
            const slot = (this.interactionNext - 1 - index + this.capacity * 2) % this.capacity;
            entries.push({ kind: clampText(this.interactionKind[slot]), ageMs: elapsed(this.interactionAt[slot], now) });
        }
        return entries;
    }

    private readFocusPane(): string | null {
        try {
            const pane = this.sources.focusPane?.() ?? null;
            return typeof pane === "string" ? clampText(pane) : null;
        } catch {
            return null;
        }
    }

    private readRejections(): UiActivityRejection[] {
        let source: readonly UiActivityRejection[];
        try {
            source = this.sources.rejections?.() ?? NO_REJECTIONS;
        } catch {
            return [];
        }
        const entries: UiActivityRejection[] = [];
        for (const rejection of source) {
            if (entries.length >= UI_ACTIVITY_LIMITS.maxEntries) break;
            entries.push({ message: clampText(rejection.message), count: rejection.count });
        }
        return entries;
    }
}

export const uiActivity = new UiActivityTracker();

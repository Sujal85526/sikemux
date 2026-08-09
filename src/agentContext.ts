import { relativePath } from "./lib/paths";

export const AGENT_CONTEXT_LIMITS = {
    items: 32,
    files: 12,
    images: 8,
    diffs: 8,
    reviews: 24,
    pathLength: 2_048,
    labelLength: 240,
    revisionLength: 160,
    commentLength: 8_192,
    excerptLength: 24_576,
    totalTextLength: 96 * 1_024,
    imageBytes: 10 * 1_024 * 1_024,
    reviewLineSpan: 2_000,
} as const;

export type AgentContextDeliveryMode = "insert-only" | "submit";
export type AgentContextReviewSide = "base" | "head" | "context";

interface PathReference {
    path: string;
    /** Required when a reference lexically resolves outside the active agent cwd. */
    external?: boolean;
}

interface OptionalLineRange {
    startLine?: number;
    endLine?: number;
}

export interface AgentContextFileReference extends PathReference, OptionalLineRange {
    kind: "file";
    label?: string;
}

export interface AgentContextImageReference extends PathReference {
    kind: "image";
    alt?: string;
    mimeType?: string;
    bytes?: number;
}

export interface AgentContextDiffReference extends PathReference, OptionalLineRange {
    kind: "diff";
    base?: string;
    head?: string;
    excerpt: string;
}

export interface AgentContextReviewReference extends PathReference {
    kind: "review";
    side: AgentContextReviewSide;
    startLine: number;
    endLine?: number;
    base?: string;
    head?: string;
    comment: string;
    excerpt?: string;
}

export type AgentContextItem = AgentContextFileReference | AgentContextImageReference | AgentContextDiffReference | AgentContextReviewReference;

export interface AgentContextLocation {
    /** Workspace visible when no provider-specific cwd has been assigned yet. */
    currentCwd: string;
    /** Effective provider cwd for an existing agent. */
    agentCwd?: string;
    /** A launch-time worktree wins when it exists. */
    worktreePath?: string;
}

/** Location is deliberately resolved at preparation time, not captured in a shelf draft. */
export type LazyAgentContextLocation = AgentContextLocation | (() => AgentContextLocation);

export type AgentContextRejectionReason =
    | "invalid-cwd"
    | "invalid-path"
    | "path-too-long"
    | "outside-agent-cwd"
    | "invalid-range"
    | "invalid-image"
    | "empty-content"
    | "field-too-long"
    | "duplicate"
    | "kind-limit"
    | "item-limit"
    | "total-text-limit";

export interface AgentContextRejection {
    index: number;
    kind: AgentContextItem["kind"];
    reason: AgentContextRejectionReason;
}

export interface NormalizedAgentContext {
    cwd: string;
    items: AgentContextItem[];
    rejected: AgentContextRejection[];
}

export interface SerializedAgentContext extends NormalizedAgentContext {
    text: string;
}

export interface PreparedAgentContextDelivery extends SerializedAgentContext {
    mode: AgentContextDeliveryMode;
    /** Caller may submit only after inserting `text`; the serializer never appends Enter. */
    submitAfterInsert: boolean;
}

const KIND_ORDER: Record<AgentContextItem["kind"], number> = { file: 0, image: 1, diff: 2, review: 3 };
const KIND_LIMIT: Record<AgentContextItem["kind"], number> = {
    file: AGENT_CONTEXT_LIMITS.files,
    image: AGENT_CONTEXT_LIMITS.images,
    diff: AGENT_CONTEXT_LIMITS.diffs,
    review: AGENT_CONTEXT_LIMITS.reviews,
};

function isAbsolutePath(path: string): boolean {
    return path.startsWith("/") || /^[a-z]:\//i.test(path);
}

/** Browser-safe lexical path normalization. Actual file reads must still resolve symlinks. */
function canonicalPath(path: string): string | null {
    if (!path || path.includes("\0")) return null;
    const source = path.replaceAll("\\", "/");
    const drive = source.match(/^[a-z]:/i)?.[0] ?? "";
    const absolute = source.startsWith("/") || Boolean(drive);
    if (!absolute) return null;
    const body = drive ? source.slice(drive.length).replace(/^\/+/, "") : source.replace(/^\/+/, "");
    const stack: string[] = [];
    for (const part of body.split("/")) {
        if (!part || part === ".") continue;
        if (part === "..") {
            if (stack.length === 0) return null;
            stack.pop();
        } else {
            stack.push(part);
        }
    }
    const prefix = drive ? `${drive.toUpperCase()}/` : "/";
    return stack.length > 0 ? `${prefix}${stack.join("/")}` : prefix;
}

function resolveLocation(source: LazyAgentContextLocation): AgentContextLocation {
    return typeof source === "function" ? source() : source;
}

export function resolveAgentContextCwd(source: LazyAgentContextLocation): string | null {
    const location = resolveLocation(source);
    for (const candidate of [location.worktreePath, location.agentCwd, location.currentCwd]) {
        if (!candidate?.trim()) continue;
        const canonical = canonicalPath(candidate.trim());
        if (canonical) return canonical;
    }
    return null;
}

function resolveReferencePath(reference: PathReference, cwd: string): { path: string; external?: true } | AgentContextRejectionReason {
    const raw = reference.path.trim();
    if (!raw || raw.includes("\0")) return "invalid-path";
    if (raw.length > AGENT_CONTEXT_LIMITS.pathLength) return "path-too-long";
    const resolved = canonicalPath(isAbsolutePath(raw.replaceAll("\\", "/")) ? raw : `${cwd}/${raw}`);
    if (!resolved) return "invalid-path";
    const relative = relativePath(resolved, cwd);
    if (relative !== null) return { path: relative || ".", external: undefined };
    if (reference.external !== true) return "outside-agent-cwd";
    return { path: resolved, external: true };
}

function validRange(startLine: number | undefined, endLine: number | undefined, maxSpan = Number.POSITIVE_INFINITY): boolean {
    if (startLine === undefined && endLine === undefined) return true;
    if (!Number.isInteger(startLine) || startLine! < 1) return false;
    const end = endLine ?? startLine!;
    return Number.isInteger(end) && end >= startLine! && end - startLine! + 1 <= maxSpan;
}

function cleanSingleLine(value: string | undefined): string | undefined {
    const clean = value?.replace(/\s+/g, " ").trim();
    return clean || undefined;
}

function normalizeItem(item: AgentContextItem, cwd: string): AgentContextItem | AgentContextRejectionReason {
    const resolved = resolveReferencePath(item, cwd);
    if (typeof resolved === "string") return resolved;
    if (item.kind === "file") {
        if (!validRange(item.startLine, item.endLine)) return "invalid-range";
        const label = cleanSingleLine(item.label);
        if ((label?.length ?? 0) > AGENT_CONTEXT_LIMITS.labelLength) return "field-too-long";
        return { ...item, ...resolved, label };
    }
    if (item.kind === "image") {
        const alt = cleanSingleLine(item.alt);
        const mimeType = cleanSingleLine(item.mimeType)?.toLocaleLowerCase();
        if ((alt?.length ?? 0) > AGENT_CONTEXT_LIMITS.labelLength || (mimeType?.length ?? 0) > 120) return "field-too-long";
        if (mimeType && !/^image\/[a-z0-9.+-]+$/.test(mimeType)) return "invalid-image";
        if (item.bytes !== undefined && (!Number.isSafeInteger(item.bytes) || item.bytes < 0 || item.bytes > AGENT_CONTEXT_LIMITS.imageBytes)) {
            return "invalid-image";
        }
        return { ...item, ...resolved, alt, mimeType };
    }
    if (item.kind === "diff") {
        const excerpt = item.excerpt.trim();
        const base = cleanSingleLine(item.base);
        const head = cleanSingleLine(item.head);
        if (!excerpt) return "empty-content";
        if (excerpt.length > AGENT_CONTEXT_LIMITS.excerptLength) return "field-too-long";
        if ((base?.length ?? 0) > AGENT_CONTEXT_LIMITS.revisionLength || (head?.length ?? 0) > AGENT_CONTEXT_LIMITS.revisionLength) {
            return "field-too-long";
        }
        if (!validRange(item.startLine, item.endLine)) return "invalid-range";
        return { ...item, ...resolved, excerpt, base, head };
    }
    const comment = item.comment.trim();
    const excerpt = item.excerpt?.trim() || undefined;
    const base = cleanSingleLine(item.base);
    const head = cleanSingleLine(item.head);
    if (!comment) return "empty-content";
    if (comment.length > AGENT_CONTEXT_LIMITS.commentLength || (excerpt?.length ?? 0) > AGENT_CONTEXT_LIMITS.excerptLength) {
        return "field-too-long";
    }
    if ((base?.length ?? 0) > AGENT_CONTEXT_LIMITS.revisionLength || (head?.length ?? 0) > AGENT_CONTEXT_LIMITS.revisionLength) {
        return "field-too-long";
    }
    if (!validRange(item.startLine, item.endLine, AGENT_CONTEXT_LIMITS.reviewLineSpan)) return "invalid-range";
    return { ...item, ...resolved, comment, excerpt, base, head, endLine: item.endLine ?? item.startLine };
}

function itemIdentity(item: AgentContextItem): string {
    if (item.kind === "file") return JSON.stringify([item.kind, item.path, item.startLine ?? 0, item.endLine ?? 0]);
    if (item.kind === "image") return JSON.stringify([item.kind, item.path]);
    if (item.kind === "diff") return JSON.stringify([item.kind, item.path, item.base ?? "", item.head ?? "", item.startLine ?? 0, item.endLine ?? 0]);
    return JSON.stringify([item.kind, item.path, item.side, item.startLine, item.endLine, item.comment]);
}

function compareItems(left: AgentContextItem, right: AgentContextItem): number {
    const kindDifference = KIND_ORDER[left.kind] - KIND_ORDER[right.kind];
    if (kindDifference !== 0) return kindDifference;
    const leftIdentity = itemIdentity(left);
    const rightIdentity = itemIdentity(right);
    return leftIdentity < rightIdentity ? -1 : leftIdentity > rightIdentity ? 1 : 0;
}

export function normalizeAgentContext(items: readonly AgentContextItem[], location: LazyAgentContextLocation): NormalizedAgentContext {
    const cwd = resolveAgentContextCwd(location);
    if (!cwd) {
        return {
            cwd: "",
            items: [],
            rejected: items.map((item, index) => ({ index, kind: item.kind, reason: "invalid-cwd" })),
        };
    }
    const accepted: AgentContextItem[] = [];
    const rejected: AgentContextRejection[] = [];
    const identities = new Set<string>();
    const kindCounts: Record<AgentContextItem["kind"], number> = { file: 0, image: 0, diff: 0, review: 0 };
    let serializedTextLength = '<agent-context version="1">\n\n</agent-context>'.length;
    for (const [index, item] of items.entries()) {
        const normalized = normalizeItem(item, cwd);
        if (typeof normalized === "string") {
            rejected.push({ index, kind: item.kind, reason: normalized });
            continue;
        }
        const identity = itemIdentity(normalized);
        const nextSerializedLength = serializeItem(normalized).length + (accepted.length > 0 ? 1 : 0);
        let reason: AgentContextRejectionReason | undefined;
        if (identities.has(identity)) reason = "duplicate";
        else if (accepted.length >= AGENT_CONTEXT_LIMITS.items) reason = "item-limit";
        else if (kindCounts[normalized.kind] >= KIND_LIMIT[normalized.kind]) reason = "kind-limit";
        else if (serializedTextLength + nextSerializedLength > AGENT_CONTEXT_LIMITS.totalTextLength) reason = "total-text-limit";
        if (reason) {
            rejected.push({ index, kind: item.kind, reason });
            continue;
        }
        identities.add(identity);
        kindCounts[normalized.kind] += 1;
        serializedTextLength += nextSerializedLength;
        accepted.push(normalized);
    }
    accepted.sort(compareItems);
    return { cwd, items: accepted, rejected };
}

function xmlEscape(value: string): string {
    return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function fenced(value: string, language: string): string {
    const escaped = xmlEscape(value);
    const longestRun = Math.max(0, ...Array.from(escaped.matchAll(/`+/g), (match) => match[0].length));
    const fence = "`".repeat(Math.max(3, longestRun + 1));
    return `${fence}${language}\n${escaped}\n${fence}`;
}

function attributes(values: Record<string, string | number | boolean | undefined>): string {
    return Object.entries(values)
        .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
        .map(([key, value]) => ` ${key}="${xmlEscape(String(value))}"`)
        .join("");
}

function serializeItem(item: AgentContextItem): string {
    const pathAttrs = { path: item.path, external: item.external || undefined };
    if (item.kind === "file") {
        return `<file${attributes({ ...pathAttrs, label: item.label, start: item.startLine, end: item.endLine })} />`;
    }
    if (item.kind === "image") {
        return `<image${attributes({ ...pathAttrs, alt: item.alt, mime: item.mimeType, bytes: item.bytes })} />`;
    }
    if (item.kind === "diff") {
        return [
            `<diff${attributes({ ...pathAttrs, base: item.base, head: item.head, start: item.startLine, end: item.endLine })}>`,
            fenced(item.excerpt, "diff"),
            "</diff>",
        ].join("\n");
    }
    const lines = [
        `<review${attributes({ ...pathAttrs, side: item.side, start: item.startLine, end: item.endLine, base: item.base, head: item.head })}>`,
        "<comment>",
        fenced(item.comment, "text"),
        "</comment>",
    ];
    if (item.excerpt) lines.push("<excerpt>", fenced(item.excerpt, "diff"), "</excerpt>");
    lines.push("</review>");
    return lines.join("\n");
}

export function serializeAgentContext(items: readonly AgentContextItem[], location: LazyAgentContextLocation): SerializedAgentContext {
    const normalized = normalizeAgentContext(items, location);
    const body = normalized.items.map(serializeItem).join("\n");
    const text = body ? `<agent-context version="1">\n${body}\n</agent-context>` : "";
    return { ...normalized, text };
}

export function prepareAgentContextDelivery(
    items: readonly AgentContextItem[],
    location: LazyAgentContextLocation,
    mode: AgentContextDeliveryMode,
): PreparedAgentContextDelivery {
    const serialized = serializeAgentContext(items, location);
    return { ...serialized, mode, submitAfterInsert: mode === "submit" };
}

import { defaultUrlTransform } from "react-markdown";
import { scanPathCandidates } from "./filePath";

/* Only the shape of an mdast node this walk cares about. The full types ship
   with packages the app does not otherwise need. */
interface MdNode {
    type: string;
    value?: string;
    url?: string;
    children?: MdNode[];
    data?: { hProperties?: Record<string, unknown> };
}

/** Marks a link this plugin made, so a false alarm can be put back as it was. */
export const PATH_CLASS = "chat-path";
/** The same, for one the agent wrote between backticks. */
export const PATH_CODE_CLASS = "chat-path-code";

function pathLink(raw: string, fromCode: boolean): MdNode {
    return {
        type: "link",
        url: raw,
        children: [{ type: "text", value: raw }],
        data: { hProperties: { className: fromCode ? [PATH_CLASS, PATH_CODE_CLASS] : [PATH_CLASS] } },
    };
}

function splitText(node: MdNode): MdNode[] | null {
    const text = node.value ?? "";
    const candidates = scanPathCandidates(text);
    if (candidates.length === 0) return null;
    const out: MdNode[] = [];
    let cursor = 0;
    for (const candidate of candidates) {
        if (candidate.start > cursor) out.push({ type: "text", value: text.slice(cursor, candidate.start) });
        out.push(pathLink(candidate.raw, false));
        cursor = candidate.end;
    }
    if (cursor < text.length) out.push({ type: "text", value: text.slice(cursor) });
    return out;
}

/* A link's own text is already a link, and a code fence is a quotation of a
   file rather than a reference to one. */
const LEAVE_ALONE = new Set(["link", "linkReference", "code", "definition", "image", "imageReference", "html"]);

function walk(node: MdNode): void {
    const children = node.children;
    if (!children) return;
    for (let index = 0; index < children.length; index++) {
        const child = children[index];
        if (LEAVE_ALONE.has(child.type)) continue;
        if (child.type === "text") {
            const split = splitText(child);
            if (!split) continue;
            children.splice(index, 1, ...split);
            index += split.length - 1;
            continue;
        }
        if (child.type === "inlineCode") {
            const raw = child.value ?? "";
            const [only] = scanPathCandidates(raw);
            if (only && only.start === 0 && only.end === raw.length) children[index] = pathLink(raw, true);
            continue;
        }
        walk(child);
    }
}

/**
 * Turns every filename a message mentions into a link to it — the ones written
 * plainly and the ones written between backticks alike. Whether the file is
 * really there is settled when the link is drawn.
 */
export function remarkFilePaths() {
    return (tree: MdNode) => walk(tree);
}

/**
 * react-markdown drops a URL whose scheme it does not trust, which would throw
 * away the local paths this transcript is full of. Those are kept; everything
 * else is judged as it was before.
 */
export function chatUrlTransform(url: string): string {
    if (/^file:\/\//i.test(url)) return url;
    if (/^[A-Za-z]:[\\/]/.test(url)) return url;
    return defaultUrlTransform(url);
}

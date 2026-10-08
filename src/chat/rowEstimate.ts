import { clampPageHeight, PAGE_DEFAULT_HEIGHT } from "./pages";
import type { ChatMessage, ChatPart } from "./types";

/* What a row is guessed at before it has been drawn, so the rows above the
   reader land near where they will be and the scroll moves little when they
   are measured. Guessed at the designed sizes, then scaled by how the rows
   drawn so far compared, which takes in the column's width and the text size. */

const LINE = 23;
const CHARS_PER_LINE = 90;
const LONGEST_TEXT = 20_000;
const FOLDED_ROW = 32;
const PICTURE = 300;
const ATTACHMENTS = 190;
const USER_ROW = 76;
const REPLY_ROW = 41;

function textHeight(text: string): number {
    let lines = 0;
    for (const line of text.slice(0, LONGEST_TEXT).split("\n")) lines += Math.max(1, Math.ceil(line.length / CHARS_PER_LINE));
    return lines * LINE;
}

function partHeight(part: ChatPart, previous: ChatPart | undefined): number {
    switch (part.kind) {
        case "text":
        case "thought":
            return textHeight(part.text);
        case "tool":
            if (part.page) return clampPageHeight(part.page.height ?? PAGE_DEFAULT_HEIGHT);
            // A run of calls folds into one line once the agent moves past it.
            return previous?.kind === "tool" && !previous.page ? 0 : FOLDED_ROW;
        case "content":
            return part.content.type === "image" ? PICTURE : FOLDED_ROW;
        default:
            return FOLDED_ROW;
    }
}

const designed = new WeakMap<ChatMessage, number>();

export function designedRowHeight(message: ChatMessage): number {
    const known = designed.get(message);
    if (known !== undefined) return known;
    let height = message.role === "user" ? USER_ROW : REPLY_ROW;
    if (message.attachments?.length) height += ATTACHMENTS;
    message.parts.forEach((part, index) => (height += partHeight(part, message.parts[index - 1])));
    designed.set(message, height);
    return height;
}

export function rowEstimator() {
    const learned = new Map<string, { designed: number; measured: number }>();
    let designedTotal = 0;
    let measuredTotal = 0;
    return {
        learn(message: ChatMessage | undefined, measured: number) {
            if (!message || measured <= 0) return;
            const before = learned.get(message.id);
            const row = { designed: designedRowHeight(message), measured };
            designedTotal += row.designed - (before?.designed ?? 0);
            measuredTotal += row.measured - (before?.measured ?? 0);
            learned.set(message.id, row);
        },
        estimate(message: ChatMessage | undefined): number {
            if (!message) return REPLY_ROW;
            const scale = designedTotal > 0 ? Math.min(3, Math.max(0.5, measuredTotal / designedTotal)) : 1;
            return Math.round(designedRowHeight(message) * scale);
        },
    };
}

import { clampPageHeight, PAGE_DEFAULT_HEIGHT } from "./pages";
import type { ChatMessage, ChatPart } from "./types";

/* What a row is guessed at before it is first drawn, guessed at the designed
   sizes. The closer it is, the truer the scrollbar on a long transcript. */

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

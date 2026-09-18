import type { ChatMessage } from "./types";

/* Nothing in the session reports how many tokens the agent wrote, so the rate
   is read off the characters that arrived: four per token is the ratio English
   prose and code both land near. The number is shown with a "~" so it reads as
   the estimate it is. */
const CHARS_PER_TOKEN = 4;

/* A burst shorter than this is one network hiccup away from any answer at all,
   so it gets no number rather than a wrong one. */
const MIN_SAMPLE_MS = 400;

export function rateLabel(rate: number): string {
    return `~${rate < 10 ? rate.toFixed(1) : Math.round(rate)} tok/s`;
}

/* What a reader means by "copy this message": the prose, the agent's reasoning
   where it showed it, and the files a turn was sent with. Tool rows are the
   pane's own bookkeeping and stay behind. */
export function messageText(message: ChatMessage): string {
    const blocks = message.parts
        .map((part) => (part.kind === "text" || part.kind === "thought" ? part.text.trim() : ""))
        .filter((text) => text.length > 0);
    for (const path of message.attachments ?? []) blocks.push(path);
    return blocks.join("\n\n");
}

/* The agent opens a fresh message every time it comes back from a tool, so one
   answer is a run of them. The run is read as the one thing it is: all of its
   prose, and the time spent writing rather than the time spent waiting on the
   tools in between. */
function answerMeta(messages: ChatMessage[], endIndex: number): { text: string; rate: number | null } {
    const blocks: string[] = [];
    let chars = 0;
    let written = 0;
    for (let index = endIndex; index >= 0 && messages[index].role === "assistant"; index -= 1) {
        const message = messages[index];
        const text = messageText(message);
        if (text) blocks.unshift(text);
        const span =
            message.streamStartedAt !== undefined && message.streamEndedAt !== undefined ? message.streamEndedAt - message.streamStartedAt : 0;
        if (span <= 0) continue;
        chars += message.streamChars ?? 0;
        written += span;
    }
    const rate = chars > 0 && written >= MIN_SAMPLE_MS ? chars / CHARS_PER_TOKEN / (written / 1000) : null;
    return { text: blocks.join("\n\n"), rate };
}

/* A prompt carries its own copy. An answer carries one only where it ends, so
   a turn gets a single row rather than one after every tool call. */
export function rowMeta(messages: ChatMessage[], index: number): { text: string; rate: number | null } {
    const message = messages[index];
    if (message.role === "user") return { text: messageText(message), rate: null };
    if (messages[index + 1]?.role === "assistant") return { text: "", rate: null };
    return answerMeta(messages, index);
}

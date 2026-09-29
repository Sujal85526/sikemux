import { basename } from "../lib/paths";

export type QueuedMessage = { id: string; text: string; paths: string[] };

export const queuedLabel = (message: QueuedMessage): string => message.text || message.paths.map(basename).join(", ");

const isCommand = (message: QueuedMessage) => message.text.startsWith("/");

/* A slash command only works as the whole prompt, so it goes out on its own. */
export function nextBatch(queued: QueuedMessage[]): QueuedMessage[] {
    if (queued.length === 0 || isCommand(queued[0])) return queued.slice(0, 1);
    const command = queued.findIndex(isCommand);
    return command === -1 ? queued : queued.slice(0, command);
}

export function combineQueued(messages: QueuedMessage[]): QueuedMessage {
    return {
        id: messages[0].id,
        text: messages
            .map((message) => message.text)
            .filter(Boolean)
            .join("\n\n"),
        paths: [...new Set(messages.flatMap((message) => message.paths))],
    };
}

import { rowMeta, type RowMeta } from '@mac/chat/messageMeta';
import type { ChatMessage } from '@mac/chat/types';

/**
 * What a held message says of itself: a prompt its own text and when it was sent; an answer, which
 * the agent splits into a message per tool call, all of its prose and how long the turn took.
 */
export function heldMeta(messages: readonly ChatMessage[], id: string): RowMeta | null {
  let index = messages.findIndex((message) => message.id === id);
  if (index < 0) return null;
  if (messages[index].role === 'assistant') while (messages[index + 1]?.role === 'assistant') index += 1;
  return rowMeta(messages as ChatMessage[], index);
}

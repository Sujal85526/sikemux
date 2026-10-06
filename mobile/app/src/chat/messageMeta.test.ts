import { describe, expect, it } from 'vitest';

import type { ChatMessage } from '@mac/chat/types';
import { heldMeta } from './messageMeta';

const message = (id: string, role: ChatMessage['role'], text: string, times: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  role,
  parts: [{ id: `${id}-text`, kind: 'text', text }],
  ...times,
});

describe('a held message', () => {
  const messages = [
    message('u1', 'user', 'Fix it', { sentAt: 1_000 }),
    message('a1', 'assistant', 'Looking.'),
    message('a2', 'assistant', 'Fixed.', { endedAt: 61_000 }),
  ];

  it('is a prompt with its own text and time', () => {
    expect(heldMeta(messages, 'u1')).toMatchObject({ text: 'Fix it', at: 1_000, took: null });
  });

  it('is the whole answer it belongs to, wherever in it the press was', () => {
    expect(heldMeta(messages, 'a1')).toMatchObject({ text: 'Looking.\n\nFixed.', at: 61_000, took: 60_000 });
    expect(heldMeta(messages, 'gone')).toBeNull();
  });
});

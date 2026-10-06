import { describe, expect, it, vi } from 'vitest';

import { cardPath, cardTap } from './responses';

vi.mock('./cards', () => ({ answerTask: vi.fn() }));

const HOST = 'ea'.repeat(32);
const card = {
  host: HOST,
  hostName: 'MacBook Pro',
  agent: 'chat-7f3a',
  kind: 'permission',
  url: `sikemux://device/${HOST}/chat/chat-7f3a`,
  request: 'r1',
  allow: 'allow-once',
  reject: 'reject-once',
};
const data = { c: 'f263cb5592e341c07fc3976942f689cc', sikemux: card };

describe('cardPath', () => {
  it("opens the chat a host's link names, and nothing else", () => {
    expect(cardPath(card.url)).toBe(`/device/${HOST}/chat/chat-7f3a`);
    expect(cardPath('https://example.com/device/x')).toBeNull();
    expect(cardPath('sikemux://pair?code=1')).toBeNull();
  });
});

describe('cardTap', () => {
  it('opens the chat on a plain tap', () => {
    expect(cardTap(data, 'com.apple.UNNotificationDefaultActionIdentifier', 'id')).toEqual({
      path: `/device/${HOST}/chat/chat-7f3a`,
      answer: null,
    });
  });

  it('answers with the option the button stands for', () => {
    expect(cardTap(data, 'allow', 'id')?.answer).toEqual({
      tag: data.c,
      host: HOST,
      agent: 'chat-7f3a',
      request: 'r1',
      option: 'allow-once',
      allow: true,
    });
    expect(cardTap(data, 'reject', 'id')?.answer).toMatchObject({ option: 'reject-once', allow: false });
  });

  it('leaves a card the phone could not read to just open the app', () => {
    expect(cardTap({ c: data.c, b: 'sealed' }, 'com.apple.UNNotificationDefaultActionIdentifier', 'id')).toBeNull();
  });
});

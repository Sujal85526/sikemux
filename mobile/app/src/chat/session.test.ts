import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatAttachment, ChatState, MobileError, type ChatInfo, type ConnectionLike } from '@sikemux/native';

import type { ChatDelivery } from '@/devices/hub';
import { ChatSession } from './session';

const FEED = 'feed-1';
const event = (kind: string, payload: Record<string, unknown> = {}) => ({ kind, payload });
const said = (text: string) =>
  event('session_update', {
    sessionId: 's',
    update: { sessionUpdate: 'agent_message_chunk', messageId: 'm', content: { type: 'text', text } },
  });
const asking = (requestId: string) =>
  event('permission_request', {
    requestId,
    sessionId: 's',
    toolCall: { toolCallId: `t-${requestId}`, title: 'rm -rf build', kind: 'execute' },
    options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
  });

function live(events: unknown[], seq: number, running = false) {
  return ChatAttachment.Live.new({
    sessionId: 's',
    capabilitiesJson: '{}',
    setupJson: '{}',
    permissionMode: 'default',
    running,
    turned: false,
    replayJson: JSON.stringify(events),
    mark: { feed: FEED, seq: BigInt(seq) },
    olderBefore: undefined,
  });
}

function fakeConnection(attachment: unknown) {
  return {
    isOpen: () => true,
    wakeChat: vi.fn(async () => {}),
    attachChat: vi.fn(async (_agent: string, _since?: { feed: string; seq: bigint }) => attachment),
    detachChat: vi.fn(async () => {}),
    prompt: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    answerPermission: vi.fn(async () => {}),
    setChatConfig: vi.fn(async () => '{}'),
    chatHistory: vi.fn(),
  };
}

function harness() {
  let take: ((deliveries: ChatDelivery[]) => void) | undefined;
  const frames: (() => void)[] = [];
  const session = new ChatSession('agent', {
    listen: (listen) => {
      take = listen;
      return () => {
        take = undefined;
      };
    },
    frame: (run) => {
      frames.push(run);
      return () => frames.splice(frames.indexOf(run), 1);
    },
  });
  let seq = 0;
  const deliver = (...events: unknown[]) =>
    take?.(events.map((payload) => ({ agentId: 'agent', seq: BigInt((seq += 1)), eventJson: JSON.stringify(payload) })));
  const startAt = (value: number) => {
    seq = value;
  };
  const drawFrame = () => frames.splice(0).forEach((run) => run());
  return { session, deliver, startAt, drawFrame };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const texts = (session: ChatSession) =>
  session.snapshot().agent.messages.flatMap((message) => message.parts.flatMap((part) => (part.kind === 'text' ? [part.text] : [])));
const info = (state: ChatState, asleep = false) => ({ agentId: 'agent', state, asleep }) as ChatInfo;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a chat session', () => {
  it('keeps events that arrived but were not drawn when the chat is left', async () => {
    const { session, deliver, startAt, drawFrame } = harness();
    const connection = fakeConnection(live([], 5));
    const release = session.hold(connection as unknown as ConnectionLike);
    await settle();
    startAt(5);
    deliver(event('turn_started'), said('half'));
    expect(session.snapshot().agent.running).toBe(false);

    release();
    expect(texts(session)).toEqual(['half']);
    expect(session.snapshot().agent.running).toBe(true);

    const resumed = fakeConnection(
      ChatAttachment.Resumed.new({ eventsJson: JSON.stringify([event('turn_completed')]), mark: { feed: FEED, seq: 8n } }),
    );
    session.hold(resumed as unknown as ConnectionLike);
    await settle();
    expect(resumed.attachChat.mock.calls[0][1]).toEqual({ feed: FEED, seq: 7n });
    expect(session.snapshot().agent.running).toBe(false);
    drawFrame();
  });

  it('moves the mark only once events are drawn', async () => {
    const { session, deliver, startAt, drawFrame } = harness();
    const first = fakeConnection(live([], 2));
    session.hold(first as unknown as ConnectionLike);
    await settle();
    startAt(2);
    deliver(said('one'));
    expect(texts(session)).toEqual([]);
    drawFrame();
    expect(texts(session)).toEqual(['one']);

    session.hostSaw(info(ChatState.Stopped), []);
    session.hostSaw(info(ChatState.Ready), []);
    await settle();
    expect(first.attachChat.mock.calls[1][1]).toEqual({ feed: FEED, seq: 3n });
  });

  it('marks a message the host did not take, and sends it again on Retry', async () => {
    const { session } = harness();
    const connection = fakeConnection(live([], 0));
    connection.prompt.mockRejectedValueOnce(MobileError.Connection.new({ message: 'the connection dropped' }));
    session.hold(connection as unknown as ConnectionLike);
    await settle();

    session.send('hello');
    expect(session.snapshot().agent.running).toBe(true);
    await settle();
    const [[id, unsent]] = [...session.snapshot().unsent];
    expect(unsent).toEqual({ state: 'failed', problem: 'the connection dropped' });
    expect(session.snapshot().agent.running).toBe(false);
    expect(texts(session)).toEqual(['hello']);

    session.retrySend(id);
    expect(session.snapshot().unsent.get(id)?.state).toBe('sending');
    await settle();
    expect(session.snapshot().unsent.size).toBe(0);
    expect(connection.prompt).toHaveBeenCalledTimes(2);
  });

  it('keeps a message it could not send through a full replay', async () => {
    const { session } = harness();
    const connection = fakeConnection(live([event('prompt', { text: 'before' }), event('turn_completed')], 2));
    connection.prompt.mockRejectedValueOnce(new Error('timed out'));
    session.hold(connection as unknown as ConnectionLike);
    await settle();
    session.send('lost');
    await settle();

    session.retry();
    await settle();
    expect(texts(session)).toEqual(['before', 'lost']);
    const [[id, unsent]] = [...session.snapshot().unsent];
    expect(unsent.state).toBe('failed');
    expect(session.snapshot().agent.messages.at(-1)?.id).toBe(id);
  });

  it('shows only the permission requests the host still waits on', async () => {
    const { session, deliver, startAt, drawFrame } = harness();
    const connection = fakeConnection(live([event('turn_started'), asking('old'), asking('open')], 3, true));
    session.hold(connection as unknown as ConnectionLike);
    await settle();
    const ids = () => session.snapshot().permissions.map((request) => request.requestId);
    expect(ids()).toEqual(['old', 'open']);

    session.hostSaw(info(ChatState.Ready), ['open']);
    expect(ids()).toEqual(['open']);

    startAt(3);
    deliver(asking('new'));
    drawFrame();
    expect(ids()).toEqual(['open', 'new']);
    vi.setSystemTime(Date.now() + 3000);
    session.hostSaw(info(ChatState.Ready), ['open', 'other']);
    expect(ids()).toEqual(['open']);
  });

  it('keeps a failed answer apart from the agent', async () => {
    const { session } = harness();
    const connection = fakeConnection(live([event('turn_started'), asking('ask')], 2, true));
    connection.answerPermission.mockRejectedValueOnce(new Error('timed out'));
    session.hold(connection as unknown as ConnectionLike);
    await settle();

    session.answer('ask', 'allow');
    session.answer('ask', 'allow');
    expect(session.snapshot().answering.has('ask')).toBe(true);
    await settle();
    expect(connection.answerPermission).toHaveBeenCalledTimes(1);
    const { agent, notice, permissions, answering } = session.snapshot();
    expect(notice).toBe('The answer did not reach the host: timed out');
    expect(agent.running).toBe(true);
    expect(agent.error).toBeNull();
    expect(permissions).toHaveLength(1);
    expect(answering.size).toBe(0);
  });

  it('sends a message held behind a turn when the turn ends', async () => {
    const { session, deliver, startAt, drawFrame } = harness();
    const connection = fakeConnection(live([event('turn_started')], 1, true));
    session.hold(connection as unknown as ConnectionLike);
    await settle();
    session.send('next');
    expect(session.snapshot().queued).toBe('next');

    startAt(1);
    deliver(event('turn_completed'));
    drawFrame();
    await settle();
    expect(connection.prompt).toHaveBeenCalledWith('agent', 'next');
    expect(session.snapshot().queued).toBeNull();
  });

  it('does not send a held message after Stop, and hands it back to the composer', async () => {
    const { session, deliver, startAt, drawFrame } = harness();
    const connection = fakeConnection(live([event('turn_started')], 1, true));
    session.hold(connection as unknown as ConnectionLike);
    await settle();
    session.setDraft('and also');
    session.send('next');

    session.cancel();
    startAt(1);
    deliver(event('turn_completed', { stopReason: 'cancelled' }));
    drawFrame();
    await settle();
    expect(connection.cancel).toHaveBeenCalled();
    expect(connection.prompt).not.toHaveBeenCalled();
    expect(session.snapshot().queued).toBeNull();
    expect(session.draftText()).toBe('next\n\nand also');
  });

  it('takes the chat up again when the host brings it back', async () => {
    const { session } = harness();
    const connection = fakeConnection(live([], 0));
    session.hold(connection as unknown as ConnectionLike);
    session.hostSaw(info(ChatState.Ready, true), []);
    await settle();
    session.hostSaw(info(ChatState.Ready), []);
    expect(connection.attachChat).toHaveBeenCalledTimes(1);

    session.hostSaw(undefined, []);
    session.hostSaw(info(ChatState.Ready), []);
    await settle();
    expect(connection.attachChat).toHaveBeenCalledTimes(2);
    expect(connection.detachChat).toHaveBeenCalledTimes(1);
  });
});

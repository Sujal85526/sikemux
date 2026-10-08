import { describe, expect, it } from 'vitest';

import { chatReducer, initialChatState } from '@mac/chat/reducer';
import type { ChatAction } from '@mac/chat/types';
import { hasLiveWork, liveKey, liveWork, planEntries } from './liveWork';

const update = (sessionId: string, fields: Record<string, unknown>): ChatAction => ({
  type: 'session_update',
  sessionId,
  update: fields,
});

describe('live work', () => {
  it('reads a plan as its named steps', () => {
    expect(
      planEntries({
        entries: [
          { content: ' Read the tests ', status: 'completed' },
          { content: 'Fix the race', status: 'in_progress' },
          { content: '', status: 'pending' },
          { content: 'Commit', status: 'something new' },
        ],
      }),
    ).toEqual([
      { content: 'Read the tests', status: 'completed' },
      { content: 'Fix the race', status: 'in_progress' },
      { content: 'Commit', status: 'pending' },
    ]);
    expect(planEntries(null)).toEqual([]);
  });

  it('counts running subagents, tasks by kind, waiting messages and an unfinished plan', () => {
    const state = [
      { type: 'turn_started' } as ChatAction,
      update('s', { sessionUpdate: 'subagent_spawned', subagentSessionId: 'a', name: 'Explore' }),
      update('s', { sessionUpdate: 'subagent_spawned', subagentSessionId: 'b', name: 'Review' }),
      update('s', { sessionUpdate: 'subagent_state_update', subagentSessionId: 'b', state: 'completed' }),
      update('s', { sessionUpdate: 'async_task_spawned', asyncTaskId: 't1', name: 'pnpm dev', taskType: 'shell' }),
      update('s', { sessionUpdate: 'async_task_spawned', asyncTaskId: 't2', name: 'CI', taskType: 'monitor' }),
      update('s', { sessionUpdate: 'async_task_spawned', asyncTaskId: 't3', name: 'tsc -w', taskType: 'shell' }),
      update('s', { sessionUpdate: 'plan', entries: [{ content: 'Fix', status: 'completed' }] }),
    ].reduce(chatReducer, initialChatState);
    const work = liveWork(state, [{ id: 'q1', text: 'and the docs', attachments: [] }]);
    expect(work.subagents.map((subagent) => subagent.name)).toEqual(['Explore']);
    expect(work.tasks.map(([kind, tasks]) => [kind, tasks.length])).toEqual([
      ['shell', 2],
      ['monitor', 1],
    ]);
    expect(work.planOpen).toBe(false);
    expect(hasLiveWork(work)).toBe(true);
    expect(hasLiveWork(liveWork(initialChatState, []))).toBe(false);
  });

  it('keys the strip on what it counts, not on what streams', () => {
    const working = chatReducer(
      initialChatState,
      update('s', { sessionUpdate: 'async_task_spawned', asyncTaskId: 't1', taskType: 'shell' }),
    );
    const said = chatReducer(working, update('s', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } }));
    const paused = chatReducer(said, update('s', { sessionUpdate: 'async_task_state_update', asyncTaskId: 't1', state: 'paused' }));
    expect(liveKey(liveWork(said, []))).toBe(liveKey(liveWork(working, [])));
    expect(liveKey(liveWork(paused, []))).not.toBe(liveKey(liveWork(working, [])));
  });
});

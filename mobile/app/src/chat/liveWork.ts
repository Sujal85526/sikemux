import { recordOf } from '@mac/chat/acpEvents';
import { groupTasks, runningSubagents } from '@mac/chat/transcript';
import type { AcpAsyncTask, AcpSubagent, ChatState } from '@mac/chat/types';
import type { Held } from './session';

export type PlanEntry = { content: string; status: 'pending' | 'in_progress' | 'completed' };

/** The checklist an agent keeps for its turn, as the steps it names. */
export function planEntries(plan: unknown): PlanEntry[] {
  const entries = recordOf(plan)?.entries;
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry): PlanEntry[] => {
    const record = recordOf(entry);
    const content = typeof record?.content === 'string' ? record.content.trim() : '';
    if (!content) return [];
    const status = record?.status === 'completed' || record?.status === 'in_progress' ? record.status : 'pending';
    return [{ content, status }];
  });
}

/** What the agent still has going besides the turn, and what waits to be sent. */
export type LiveWork = {
  subagents: AcpSubagent[];
  tasks: [string, AcpAsyncTask[]][];
  queued: readonly Held[];
  plan: PlanEntry[];
  /** Some step of the plan is still to do. */
  planOpen: boolean;
};

export function liveWork(state: ChatState, queued: readonly Held[]): LiveWork {
  const plan = planEntries(state.plan);
  return {
    subagents: runningSubagents(state.messages),
    tasks: groupTasks(state.tasks),
    queued,
    plan,
    planOpen: plan.some((entry) => entry.status !== 'completed'),
  };
}

/** What the strip counts, which changes far less often than the chat does. */
export function liveKey(work: LiveWork): string {
  return JSON.stringify([
    work.subagents.map((subagent) => subagent.sessionId),
    work.tasks.map(([kind, tasks]) => [kind, tasks.map((task) => `${task.asyncTaskId}:${task.state}`)]),
    work.queued.map((held) => held.id),
    work.plan.map((entry) => entry.status),
  ]);
}

export function hasLiveWork(work: LiveWork): boolean {
  return work.subagents.length > 0 || work.tasks.length > 0 || work.queued.length > 0 || work.planOpen;
}

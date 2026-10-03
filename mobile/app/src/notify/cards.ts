import { MobileError, type CoreListener } from '@sikemux/native';

import { notifier, type AnswerOutcome, type ShownCard } from '../../modules/notify';
import type { Snapshot } from '@/core/protocol';
import { thisDevice } from '@/device/identity';

/** Permission cards whose request the host no longer has: it was answered or withdrawn elsewhere. */
export function settledCards(shown: ShownCard[], host: string, snapshot: Snapshot): string[] {
  const pending = new Set(snapshot.attentions.map((attention) => attention.id));
  return shown
    .filter((card) => card.host === host && card.kind === 'permission' && card.request && !pending.has(card.request))
    .map((card) => card.tag);
}

/** Removes the cards a host's current view shows are settled, as the app hears it. */
export function reconcileCards(host: string, snapshot: Snapshot) {
  if (!notifier) return;
  settledCards(notifier.shown(), host, snapshot).forEach((tag) => notifier?.dismiss(tag));
}

/** Removes the cards about one agent, once the person is looking at it. */
export function dismissCardsFor(host: string, agent: string) {
  if (!notifier) return;
  notifier
    .shown()
    .filter((card) => card.host === host && card.agent === agent)
    .forEach((card) => notifier?.dismiss(card.tag));
}

export type CardAnswer = { tag: string; host: string; agent: string; request: string; option: string; allow: boolean };

const quiet: CoreListener = {
  output() {},
  events() {},
  closed() {},
};

export function isGone(error: unknown): boolean {
  return MobileError.Refused.instanceOf(error) && /no longer pending/.test(error.inner.message);
}

/** Answers a permission request from its card over the phone's own connection to the host. */
export async function answerFromCard(answer: CardAnswer): Promise<AnswerOutcome> {
  let connection;
  try {
    const device = await thisDevice();
    connection = await device.connect(answer.host, quiet);
    await connection.answerPermission(answer.agent, answer.request, answer.option);
    return answer.allow ? 'answered' : 'rejected';
  } catch (error) {
    if (isGone(error)) return 'gone';
    console.warn('sikemux: could not answer from the notification', error);
    return 'failed';
  } finally {
    connection?.close();
  }
}

/** The task Android runs, without a screen, when Allow or Reject is tapped on a card. */
export async function answerTask(data: CardAnswer) {
  const outcome = await answerFromCard(data);
  notifier?.settle(data.tag, outcome);
}

import { requireOptionalNativeModule } from 'expo';

export type ShownCard = { tag: string; host: string; agent?: string; kind?: string; request?: string };

/** How an answer from a card went, as the card then says. */
export type AnswerOutcome = 'answered' | 'rejected' | 'gone' | 'failed';

type NotifyModule = {
  setPhone(phone: string): void;
  key(host: string): { keyId: number; key: string } | null;
  setKey(host: string, keyId: number, key: string): void;
  removeKey(host: string): void;
  removeAll(): void;
  shown(): ShownCard[];
  dismiss(tag: string): void;
  settle(tag: string, outcome: AnswerOutcome): void;
};

/** The Android half of notifications: the keys hosts seal cards with, and the cards showing. Absent on iOS for now. */
export const notifier = requireOptionalNativeModule<NotifyModule>('SikemuxNotify');

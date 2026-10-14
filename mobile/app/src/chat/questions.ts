import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ConnectionLike } from '@sikemux/native';

import { asksPerson, type AgentQuestion, type QuestionAnswer } from '@mac/agents/agentQuestions';

export type ChatQuestions = {
  /** What the agent asked the person and waits on, oldest first. */
  open: AgentQuestion[];
  /** Answered from this phone, until the transcript holds the answer. */
  answered: { question: AgentQuestion; answer: string }[];
  busy: string | null;
  /** The question whatever the composer sends answers, while one is open and the person has not taken the chip off. */
  composing: AgentQuestion | null;
  /** The person chose to write the answer. */
  writing: boolean;
  answer: (question: AgentQuestion, given: QuestionAnswer, shown: string) => Promise<boolean>;
  write: (question: AgentQuestion) => void;
  stopComposing: () => void;
};

/**
 * The questions an agent put to the person, read with the host's `questions` call whenever `seen` changes, and
 * answered with `answerQuestion`. The first answer anywhere wins.
 */
export function useQuestions(
  connection: ConnectionLike | undefined,
  agentId: string,
  seen: string,
  arrived: ReadonlySet<string>,
  onError: (problem: string) => void,
): ChatQuestions {
  const [all, setAll] = useState<AgentQuestion[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [sent, setSent] = useState<{ question: AgentQuestion; answer: string }[]>([]);
  const [writingId, setWritingId] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());

  const [reads, setReads] = useState(0);

  useEffect(() => {
    if (!connection) return;
    let current = true;
    connection.call('questions', 'null').then(
      (text) => {
        const list = JSON.parse(text) as AgentQuestion[];
        if (current) setAll(list.filter((question) => question.agentId === agentId && asksPerson(question) && question.blocked));
      },
      // A host from before questions has no such call.
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [connection, agentId, seen, reads]);

  const open = useMemo(() => all.filter((question) => !sent.some((answered) => answered.question.id === question.id)), [all, sent]);
  const answered = useMemo(() => sent.filter(({ question }) => !arrived.has(question.asked)), [sent, arrived]);
  const writing = open.find((question) => question.id === writingId) ?? null;
  const composing = writing ?? open.find((question) => !dismissed.has(question.id)) ?? null;

  const answer = useCallback(
    async (question: AgentQuestion, given: QuestionAnswer, shown: string) => {
      if (!connection) return false;
      setBusy(question.id);
      try {
        await connection.call('answerQuestion', JSON.stringify({ id: question.id, ...given }));
        setSent((current) => [...current, { question, answer: shown }]);
        setWritingId((current) => (current === question.id ? null : current));
        return true;
      } catch (error) {
        onError(error instanceof Error ? error.message : String(error));
        setReads((count) => count + 1);
        return false;
      } finally {
        setBusy(null);
      }
    },
    [connection, onError],
  );

  const write = useCallback((question: AgentQuestion) => setWritingId(question.id), []);
  const stopComposing = useCallback(() => {
    if (!composing) return;
    setWritingId(null);
    setDismissed((current) => new Set(current).add(composing.id));
  }, [composing]);

  return { open, answered, busy, composing, writing: writing !== null, answer, write, stopComposing };
}

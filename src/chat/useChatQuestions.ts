import { useCallback, useMemo, useState } from "react";
import { errorText } from "../lib/format";
import { asksPerson, type AgentQuestion, type QuestionAnswer } from "../agents/agentQuestions";
import { agentQuestionsApi } from "../api/agentQuestions";
import { useStore } from "../state/store";
import { messageLetters } from "./agentLetters";
import type { ChatMessage } from "./types";

const NO_QUESTIONS: AgentQuestion[] = [];

export interface ChatQuestions {
    /** What the agent asked the person and waits on, oldest first. */
    open: AgentQuestion[];
    /** Questions the agent went on without, on an assumption. */
    assumed: AgentQuestion[];
    /** Answered here, until the transcript holds the answer. */
    answered: { question: AgentQuestion; answer: string }[];
    /** The question whose answer is on its way. */
    busy: string | null;
    /** The question whatever is sent from the composer answers; never a secret one, which has its own masked field. */
    composing: AgentQuestion | null;
    /** The composer answers the question because the person chose to write the answer. */
    writing: boolean;
    answer: (question: AgentQuestion, answer: QuestionAnswer, shown: string | null) => Promise<boolean>;
    choose: (question: AgentQuestion, choice: number) => void;
    write: (question: AgentQuestion) => void;
    stopComposing: () => void;
}

/** The questions an agent put to the person, answered in its chat. */
export function useChatQuestions(agentId: string, messages: readonly ChatMessage[], onError: (message: string | null) => void): ChatQuestions {
    const all = useStore((s) => s.agentQuestions);
    const mine = useMemo(() => {
        const found = all.filter((question) => question.agentId === agentId && asksPerson(question));
        return found.length > 0 ? found : NO_QUESTIONS;
    }, [all, agentId]);
    const [busy, setBusy] = useState<string | null>(null);
    const [sent, setSent] = useState<{ question: AgentQuestion; answer: string | null }[]>([]);
    const unanswered = useMemo(() => mine.filter((question) => !sent.some((answered) => answered.question.id === question.id)), [mine, sent]);
    const open = useMemo(() => unanswered.filter((question) => question.blocked), [unanswered]);
    const assumed = useMemo(() => unanswered.filter((question) => !question.blocked), [unanswered]);
    const [writingId, setWritingId] = useState<string | null>(null);
    const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());

    const answered = useMemo(() => {
        const shown = sent.flatMap(({ question, answer }) => (answer === null ? [] : [{ question, answer }]));
        if (shown.length === 0) return shown;
        const arrived = new Set(
            messages.flatMap((message) => (messageLetters(message) ?? []).flatMap((letter) => (letter.kind === "answer" ? [letter.question] : []))),
        );
        return shown.filter(({ question }) => !arrived.has(question.asked));
    }, [messages, sent]);

    const writing = unanswered.find((question) => question.id === writingId && !question.secret) ?? null;
    const composing = writing ?? open.find((question) => !question.secret && !dismissed.has(question.id)) ?? null;

    const answer = useCallback(
        async (question: AgentQuestion, given: QuestionAnswer, shown: string | null) => {
            setBusy(question.id);
            onError(null);
            try {
                await agentQuestionsApi.answer(question.id, given);
                setSent((current) => [...current, { question, answer: shown }]);
                setWritingId((current) => (current === question.id ? null : current));
                return true;
            } catch (error) {
                onError(errorText(error));
                return false;
            } finally {
                setBusy(null);
            }
        },
        [onError],
    );

    const choose = useCallback(
        (question: AgentQuestion, choice: number) => void answer(question, { choice }, question.choices[choice]?.label ?? null),
        [answer],
    );

    const write = useCallback((question: AgentQuestion) => {
        setWritingId(question.id);
        setDismissed((current) => {
            if (!current.has(question.id)) return current;
            const next = new Set(current);
            next.delete(question.id);
            return next;
        });
    }, []);

    const stopComposing = useCallback(() => {
        if (!composing) return;
        setWritingId(null);
        setDismissed((current) => new Set(current).add(composing.id));
    }, [composing]);

    return { open, assumed, answered, busy, composing, writing: writing !== null, answer, choose, write, stopComposing };
}

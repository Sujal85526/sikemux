export interface QuestionChoice {
    readonly label: string;
    readonly detail?: string;
}

/** A question an agent asked with `ask` or its CLI's own tool, as the core keeps it until someone answers. */
export interface AgentQuestion {
    readonly id: string;
    readonly agentId: string;
    /** The asker's name, such as Maple. */
    readonly name: string;
    readonly cli: string;
    readonly project: string;
    /** The asker's own words. */
    readonly asked: string;
    /** What the person is asked, which a lead that passed it on may have reworded. */
    readonly text: string;
    readonly choices: QuestionChoice[];
    /** The asker waits for the answer; otherwise it goes on with `assumption`. */
    readonly blocked: boolean;
    readonly assumption: string | null;
    readonly at: number;
    /** The lead it waits on, while it has not reached the person. */
    readonly lead: string | null;
    /** The lead it went to first, once it reached the person. */
    readonly via: string | null;
    /** That lead passed it on itself rather than leaving it unanswered. */
    readonly passed: boolean;
}

export type QuestionAnswer = { readonly answer: string } | { readonly choice: number } | { readonly fine: true };

export const asksPerson = (question: AgentQuestion): boolean => question.lead === null;

/** The question the agent waits on the person to answer, the first it asked. */
export const blockingQuestion = (questions: readonly AgentQuestion[], agentId: string): AgentQuestion | undefined =>
    questions.find((question) => question.agentId === agentId && question.blocked && asksPerson(question));

/** A question the agent went on without, on an assumption the person has not answered. */
export const assumedQuestion = (questions: readonly AgentQuestion[], agentId: string): AgentQuestion | undefined =>
    questions.find((question) => question.agentId === agentId && !question.blocked && asksPerson(question));

export const waitsOnPerson = (questions: readonly AgentQuestion[], agentId: string): boolean => blockingQuestion(questions, agentId) !== undefined;

/** Why a question reached the person rather than the lead it went to first. */
export function viaNote(question: Pick<AgentQuestion, "via" | "passed">): string | null {
    if (!question.via) return null;
    return question.passed ? `${question.via} didn't know` : `${question.via} didn't answer`;
}

import type { AgentQuestion, QuestionAnswer } from "../agents/agentQuestions";
import { invokeCommand as invoke } from "./invoke";

/** Sent by the window whenever the open questions change. */
export const AGENT_QUESTIONS_EVENT = "agent_questions";

export const agentQuestionsApi = {
    list: () => invoke<AgentQuestion[]>("agent_question_call", { method: "questions", params: null }),
    answer: (id: string, answer: QuestionAnswer) =>
        invoke<{ answered: boolean }>("agent_question_call", { method: "answerQuestion", params: { id, ...answer } }),
};

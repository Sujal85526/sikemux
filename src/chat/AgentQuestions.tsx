import type { ReactNode } from "react";
import { AgentMark } from "../agents/AgentMark";
import type { AnswerLetter } from "./agentLetters";

/** Who is asking, above the question itself. */
export function AskedBy({ cli, ticket, children }: { cli: string; ticket?: string; children: ReactNode }) {
    return (
        <div className="chat-ask-who">
            <AgentMark cli={cli} size={16} />
            <span>{children}</span>
            {ticket && <span className="chat-ask-ticket">{ticket}</span>}
        </div>
    );
}

/** A question as it reads once answered: its words, and the answer in one line. */
export function AnsweredQuestion({ letter }: { letter: AnswerLetter }) {
    return (
        <>
            <AskedBy cli={letter.cli}>
                <b>{letter.asker}</b> asked you
            </AskedBy>
            <div className="chat-ask-text">{letter.question}</div>
            <div className="chat-ask-answered">
                <span>You answered:</span> <span className="chat-ask-answer">{letter.text}</span>
            </div>
        </>
    );
}

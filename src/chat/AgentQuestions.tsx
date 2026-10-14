import type { ReactNode } from "react";
import { viaNote, type AgentQuestion } from "../agents/agentQuestions";
import { isAgentType } from "../agents/catalog";
import { AgentIcon, IconCheck } from "../ui/Icons";
import type { AnswerLetter } from "./agentLetters";

function AgentMark({ cli }: { cli: string }) {
    return isAgentType(cli) ? <AgentIcon type={cli} size={16} className={`agent-glyph ${cli}`} /> : null;
}

/** Who is asking, above the question itself. */
function AskedBy({ cli, ticket, children }: { cli: string; ticket?: string; children: ReactNode }) {
    return (
        <div className="chat-ask-who">
            <AgentMark cli={cli} />
            <span>{children}</span>
            {ticket && <span className="chat-ask-ticket">{ticket}</span>}
        </div>
    );
}

/**
 * A question an agent put to the person: its words as prose, then the answers it offered as a numbered list. "Something
 * else…" hands over to the composer, which answers it with whatever is sent.
 */
export function OpenQuestion({
    question,
    busy,
    writing,
    onChoose,
    onSomethingElse,
}: {
    question: AgentQuestion;
    busy: boolean;
    /** The composer is answering it. */
    writing: boolean;
    onChoose: (choice: number) => void;
    onSomethingElse: () => void;
}) {
    const via = viaNote(question);
    return (
        <article className="chat-message agent-question">
            <div className="chat-message-content">
                <AskedBy cli={question.cli} ticket={question.ticket}>
                    <b>{question.name}</b> asks you{via && ` · ${via}`}
                </AskedBy>
                <div className="chat-ask-text">{question.text}</div>
                <div className="chat-ask-options" role="group" aria-label={`Answer ${question.name}`}>
                    {question.choices.map((choice, index) => (
                        <button key={index} type="button" className="chat-ask-option" disabled={busy} onClick={() => onChoose(index)}>
                            <span className="chat-ask-key">{index + 1}</span>
                            <span>{choice.label}</span>
                            {choice.detail && <span className="chat-ask-why">{choice.detail}</span>}
                        </button>
                    ))}
                    <button type="button" className={`chat-ask-option other${writing ? " writing" : ""}`} disabled={busy} onClick={onSomethingElse}>
                        <span className="chat-ask-key">{question.choices.length + 1}</span>
                        <span>Something else…</span>
                        {writing && <span className="chat-ask-why">answering below</span>}
                    </button>
                </div>
            </div>
        </article>
    );
}

/** A question the agent went on without, on the assumption it stated. */
export function AssumedQuestion({
    question,
    busy,
    onFine,
    onChange,
}: {
    question: AgentQuestion;
    busy: boolean;
    onFine: () => void;
    onChange: () => void;
}) {
    return (
        <div className="chat-message agent-question">
            <div className="chat-message-content">
                <div className="chat-ask-assumed" title={question.text}>
                    <IconCheck size={14} />
                    <span>
                        <b>{question.name}</b> assumed {question.assumption}
                    </span>
                    <span className="chat-ask-dot">·</span>
                    <button type="button" disabled={busy} onClick={onFine}>
                        Fine
                    </button>
                    <button type="button" disabled={busy} onClick={onChange}>
                        Change
                    </button>
                </div>
            </div>
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

/** What a just-answered question shows until the agent's transcript has the answer. */
export function JustAnswered({ question, answer }: { question: AgentQuestion; answer: string }) {
    return (
        <article className="chat-message agent-question">
            <div className="chat-message-content">
                <AnsweredQuestion letter={{ kind: "answer", asker: question.name, cli: question.cli, question: question.text, text: answer }} />
            </div>
        </article>
    );
}

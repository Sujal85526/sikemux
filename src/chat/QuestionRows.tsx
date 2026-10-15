import { useEffect, useRef, useState, type RefObject } from "react";
import { secretNote, viaNote, type AgentQuestion } from "../agents/agentQuestions";
import { IconCheck, IconLock } from "../ui/Icons";
import { AnsweredQuestion, AskedBy } from "./AgentQuestions";
import type { ChatQuestions } from "./useChatQuestions";

/** The answer to a secret question, typed into a masked field that keeps nothing once it is sent. */
function SecretAnswer({ question, busy, onSend }: { question: AgentQuestion; busy: boolean; onSend: (text: string) => Promise<boolean> }) {
    const [text, setText] = useState("");
    return (
        <form
            className="chat-ask-secret"
            onSubmit={(event) => {
                event.preventDefault();
                if (text) void onSend(text).then((sent) => sent && setText(""));
            }}>
            <div className="chat-ask-secret-field">
                <input
                    type="password"
                    name={`secret-${question.id}`}
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    aria-label={`Private answer to ${question.name}`}
                    placeholder="Type the answer"
                    value={text}
                    disabled={busy}
                    onChange={(event) => setText(event.target.value)}
                />
                <button type="submit" disabled={busy || !text}>
                    Send
                </button>
            </div>
            <div className="chat-ask-private">
                <IconLock size={12} />
                <span>{secretNote(question.name)}</span>
            </div>
        </form>
    );
}

/**
 * A question an agent put to the person: its words as prose, then the answers it offered as a numbered list. "Something
 * else…" hands over to the composer, which answers it with whatever is sent. A secret is typed into its own masked field
 * instead, so it never reaches the composer's drafts or history.
 */
function OpenQuestion({
    question,
    busy,
    writing,
    onChoose,
    onSomethingElse,
    onSecret,
}: {
    question: AgentQuestion;
    busy: boolean;
    /** The composer is answering it. */
    writing: boolean;
    onChoose: (choice: number) => void;
    onSomethingElse: () => void;
    onSecret: (text: string) => Promise<boolean>;
}) {
    const via = viaNote(question);
    return (
        <article className="chat-message agent-question">
            <div className="chat-message-content">
                <AskedBy cli={question.cli} ticket={question.ticket}>
                    <b>{question.name}</b> asks you{via && ` · ${via}`}
                </AskedBy>
                <div className="chat-ask-text">{question.text}</div>
                {(question.choices.length > 0 || !question.secret) && (
                    <div className="chat-ask-options" role="group" aria-label={`Answer ${question.name}`}>
                        {question.choices.map((choice, index) => (
                            <button key={index} type="button" className="chat-ask-option" disabled={busy} onClick={() => onChoose(index)}>
                                <span className="chat-ask-key">{index + 1}</span>
                                <span>{choice.label}</span>
                                {choice.detail && <span className="chat-ask-why">{choice.detail}</span>}
                            </button>
                        ))}
                        {!question.secret && (
                            <button
                                type="button"
                                className={`chat-ask-option other${writing ? " writing" : ""}`}
                                disabled={busy}
                                onClick={onSomethingElse}>
                                <span className="chat-ask-key">{question.choices.length + 1}</span>
                                <span>Something else…</span>
                                {writing && <span className="chat-ask-why">answering below</span>}
                            </button>
                        )}
                    </div>
                )}
                {question.secret && <SecretAnswer question={question} busy={busy} onSend={onSecret} />}
            </div>
        </article>
    );
}

/** A question the agent went on without, on the assumption it stated. */
function AssumedQuestion({ question, busy, onFine, onChange }: { question: AgentQuestion; busy: boolean; onFine: () => void; onChange: () => void }) {
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

const isEditable = (target: EventTarget | null): boolean =>
    target instanceof HTMLElement && Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));

/** The questions an agent put to the person, at the foot of its chat; a number key answers the first one waiting. */
export default function QuestionRows({
    questions,
    active,
    paneRef,
    onWrite,
    onDigit,
}: {
    questions: ChatQuestions;
    active: boolean;
    paneRef: RefObject<HTMLDivElement | null>;
    onWrite: (question: AgentQuestion) => void;
    onDigit: (digit: number) => boolean;
}) {
    const onDigitRef = useRef(onDigit);
    onDigitRef.current = onDigit;
    const asking = questions.open.length > 0;
    useEffect(() => {
        if (!active || !asking) return;
        const onKey = (event: KeyboardEvent) => {
            if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || !/^[1-9]$/.test(event.key)) return;
            const held = document.activeElement;
            if (isEditable(event.target) || (held && held !== document.body && !paneRef.current?.contains(held))) return;
            if (onDigitRef.current(Number(event.key))) event.preventDefault();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [active, asking, paneRef]);

    return (
        <>
            {questions.answered.map(({ question, answer }) => (
                <article key={question.id} className="chat-message agent-question">
                    <div className="chat-message-content">
                        <AnsweredQuestion
                            letter={{
                                kind: "answer",
                                asker: question.name,
                                cli: question.cli,
                                question: question.text,
                                text: answer,
                                secret: question.secret,
                            }}
                        />
                    </div>
                </article>
            ))}
            {questions.open.map((question) => (
                <OpenQuestion
                    key={question.id}
                    question={question}
                    busy={questions.busy === question.id}
                    writing={questions.writing && questions.composing?.id === question.id}
                    onChoose={(choice) => questions.choose(question, choice)}
                    onSomethingElse={() => onWrite(question)}
                    onSecret={(text) => questions.answer(question, { answer: text }, "")}
                />
            ))}
            {questions.assumed.map((question) => (
                <AssumedQuestion
                    key={question.id}
                    question={question}
                    busy={questions.busy === question.id}
                    onFine={() => void questions.answer(question, { fine: true }, null)}
                    onChange={() => onWrite(question)}
                />
            ))}
        </>
    );
}

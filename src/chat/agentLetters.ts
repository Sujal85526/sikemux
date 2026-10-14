import type { ChatMessage } from "./types";

/** A message another agent sent with agent_send, as the core labels it for the agent that gets it. */
export interface AgentLetter {
    name: string;
    agentId: string;
    cli: string;
    text: string;
}

const LETTER = /<agent-message from="([^"]*)" agent-id="([^"]*)" cli="([^"]*)"[^>]*>\n([\s\S]*?)\n<\/agent-message>/g;

const unescaped = (value: string) =>
    value
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&");

export const isAgentLetter = (text: string): boolean => text.trimStart().startsWith("<agent-message ");

/** The messages from other agents a text is made of, or null when it holds anything else. */
export function agentLetters(text: string): AgentLetter[] | null {
    if (!isAgentLetter(text)) return null;
    const letters: AgentLetter[] = [];
    const rest = text.replace(LETTER, (_whole, name: string, agentId: string, cli: string, body: string) => {
        letters.push({
            name: unescaped(name),
            agentId: unescaped(agentId),
            cli: unescaped(cli),
            text: body.replace(/&lt;\/agent-message/g, "</agent-message"),
        });
        return "";
    });
    return letters.length > 0 && rest.trim() === "" ? letters : null;
}

/** What a sent message holds from other agents, when that is all it holds. */
export function messageLetters(message: ChatMessage): AgentLetter[] | null {
    if (message.role !== "user" || message.parts.some((part) => part.kind !== "text")) return null;
    return agentLetters(message.parts.map((part) => (part.kind === "text" ? part.text : "")).join(""));
}

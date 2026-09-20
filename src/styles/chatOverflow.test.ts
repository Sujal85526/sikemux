import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const chat = readFileSync(join(process.cwd(), "src", "styles", "chat.css"), "utf8");

function block(selector: string): string {
    const match = chat.match(new RegExp(`(^|\\n)${selector.replace(/[.\\-]/g, "\\$&")}\\s*\\{([^}]*)\\}`));
    expect(match, `${selector} is missing from chat.css`).not.toBeNull();
    return match?.[2] ?? "";
}

const agents = readFileSync(join(process.cwd(), "src", "styles", "agents.css"), "utf8");

describe("the yolo ring", () => {
    /* A gradient that moves by its own background position repaints the ring
       on every frame, and the ring is on screen for as long as the mode is. A
       strip that slides behind a fixed window is the compositor's work. */
    it("moves a strip rather than repainting the border", () => {
        for (const sheet of [chat, agents]) {
            expect(sheet).not.toMatch(/animation:\s*yolo-flow/);
            expect(sheet).toMatch(/\.yolo-ring::before\s*\{[^}]*animation:\s*yolo-slide/);
            expect(sheet).toMatch(/\.yolo-ring\s*\{[^}]*overflow:\s*hidden/);
        }
        expect(agents).toMatch(/@keyframes yolo-slide\s*\{[^@]*transform:\s*translateX\(-50%\)/);
    });
});

describe("chat overflow", () => {
    /* A user bubble is sized to its own content, and a box sized that way grows
       to fit the longest word in it. A pasted URL is one word, so the bubble
       reached past the pane and took the whole screen sideways with it.
       `break-word` would not have helped: it wraps the text but leaves the box's
       smallest width — and so the bubble — as wide as the URL. */
    it("breaks inside a word that has nowhere else to break", () => {
        expect(block(".chat-markdown")).toMatch(/overflow-wrap:\s*anywhere/);
        expect(block(".chat-message.user .chat-markdown")).toMatch(/width:\s*max-content/);
    });

    /* Agents name a background task with the command they ran, which is a line
       of shell. A name that cannot shrink pushed the row, its stop button and
       the pane's right edge off screen. */
    /* The pane is a grid, and a grid with rows but no columns widens to the
       longest unbreakable run inside it — one queued message holding a link
       pushed the transcript and the composer off the right edge. */
    it("holds the pane to one column of its own width", () => {
        expect(block(".agent-chat-pane")).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\)/);
    });

    it("lets a long task name give way rather than the row", () => {
        const name = block(".chat-task-name");
        expect(name).not.toMatch(/flex:\s*none/);
        expect(name).toMatch(/text-overflow:\s*ellipsis/);
        expect(name).toMatch(/min-width:\s*0/);
    });
});

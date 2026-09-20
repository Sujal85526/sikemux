import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TabBar } from "./TabBar";

afterEach(cleanup);

const shell = readFileSync(join(process.cwd(), "src", "styles", "modern-shell.css"), "utf8");

/*
 * A busy tab used to carry its spinner inside the pill and its close after it,
 * so the close sat a whole mark in from the edge and every quiet tab showed the
 * gap where a spinner would have gone. One slot holds both.
 */
it("hangs the status mark and the close in the same slot", () => {
    const { container } = render(
        <TabBar
            variant="agent"
            tabs={[{ id: "a", label: "Agent", accessory: <span className="agent-activity state-working" /> }]}
            onSelect={vi.fn()}
            onClose={vi.fn()}
        />,
    );

    const tail = container.querySelector(".tab-tail");
    expect(tail?.querySelector(".tab-status .agent-activity")).toBeInTheDocument();
    expect(tail?.querySelector(".tab-x")).toBeInTheDocument();
    expect(container.querySelector(".tab .agent-activity")).toBeNull();
});

it("gives the unsaved dot that slot when a tab has no status of its own", () => {
    const { container } = render(
        <TabBar variant="editor" tabs={[{ id: "a", label: "File.ts", dirty: true }]} onSelect={vi.fn()} onClose={vi.fn()} />,
    );

    expect(container.querySelector(".tab-tail .tab-status .tab-dot")).toBeInTheDocument();
});

it("leaves a tab with neither mark nor close no slot to pay for", () => {
    const { container } = render(<TabBar variant="stack" tabs={[{ id: "a", label: "Pane", closable: false }]} onSelect={vi.fn()} />);

    expect(container.querySelector(".tab-tail")).toBeNull();
});

/* The swap is the whole point: reaching for a row has to uncover the close,
   not stack it on top of the spinner. */
it("hides the mark exactly where the close is revealed", () => {
    const reveal = shell.match(/([^}]*)\{\s*opacity: 1;\s*pointer-events: auto;/)?.[1] ?? "";
    const hide = shell.match(/([^}]*)\{\s*opacity: 0;\s*\}/g)?.join("") ?? "";
    for (const wrap of [".tab-wrap:hover", ".session-row-shell:hover", ".agent-row-wrap:hover"]) {
        expect(reveal).toContain(wrap);
        expect(hide).toContain(wrap);
    }
});

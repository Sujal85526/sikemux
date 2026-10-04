import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryOutcome, ResultSet } from "../api";

const host = vi.hoisted(() => ({ copyText: vi.fn() }));
vi.mock("../../../plugin-api/host", async (importOriginal) => ({ ...(await importOriginal<object>()), ...host }));

import { ResultsView } from "./ResultsView";

const customers: ResultSet = {
    columns: [
        { name: "id", type: "int4", numeric: true },
        { name: "email", type: "text", numeric: false },
    ],
    rows: [
        [1, "ada@example.com"],
        [2, null],
    ],
    truncated: false,
    affected: null,
};

const changed: ResultSet = { columns: [], rows: [], truncated: false, affected: 2 };

afterEach(cleanup);
beforeEach(() => {
    host.copyText.mockReset();
    host.copyText.mockResolvedValue(undefined);
});

describe("ResultsView", () => {
    it("shows the rows with their column types, numbers to the right and NULL marked", () => {
        render(<ResultsView outcome={{ results: [customers], millis: 12 }} />);
        expect(screen.getByRole("status")).toHaveTextContent("2 rows · 12 ms");
        expect(screen.getByRole("columnheader", { name: /^id\s*int4$/ })).toHaveClass("numeric");
        const nullCell = screen.getByText("NULL");
        expect(nullCell).toHaveClass("null");
        expect(screen.getByText("ada@example.com")).not.toHaveClass("numeric");
    });

    it("says how many rows a change touched", () => {
        render(<ResultsView outcome={{ results: [changed], millis: 3 }} />);
        expect(screen.getByText("2 rows changed.")).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
    });

    it("opens on the last result with rows and switches between statements", () => {
        const outcome: QueryOutcome = { results: [changed, customers, changed], millis: 5 };
        render(<ResultsView outcome={outcome} />);
        const tabs = within(screen.getByRole("tablist", { name: "Statements" })).getAllByRole("tab");
        expect(tabs).toHaveLength(3);
        expect(tabs[1]).toHaveAttribute("aria-selected", "true");
        fireEvent.click(tabs[0]);
        expect(screen.getByText("2 rows changed.")).toBeInTheDocument();
    });

    it("copies the whole result, and the full value of a picked cell", () => {
        render(<ResultsView outcome={{ results: [customers], millis: 1 }} />);
        fireEvent.click(screen.getByRole("button", { name: "Copy" }));
        expect(host.copyText).toHaveBeenLastCalledWith("id\temail\n1\tada@example.com\n2\t");
        fireEvent.click(screen.getByText("ada@example.com"));
        const inspector = screen.getByLabelText("Selected cell");
        expect(inspector).toHaveTextContent("email");
        fireEvent.click(within(inspector).getByRole("button", { name: "Copy value" }));
        expect(host.copyText).toHaveBeenLastCalledWith("ada@example.com");
    });

    it("draws a long result a page at a time", () => {
        const many: ResultSet = { ...customers, rows: Array.from({ length: 1500 }, (_, at) => [at, `row ${at}`]) };
        render(<ResultsView outcome={{ results: [many], millis: 1 }} />);
        expect(screen.queryByText("row 1200")).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Show 500 more rows" }));
        expect(screen.getByText("row 1200")).toBeInTheDocument();
    });

    it("puts the caller's actions beside Copy", () => {
        render(<ResultsView outcome={{ results: [customers], millis: 1 }} actions={() => <button type="button">Send</button>} />);
        expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
    });
});

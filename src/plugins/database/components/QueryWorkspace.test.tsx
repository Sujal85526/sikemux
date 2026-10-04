import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseProfile } from "../api";

const api = vi.hoisted(() => ({ query: vi.fn(), cancel: vi.fn() }));
vi.mock("../api", async (importOriginal) => ({ ...(await importOriginal<object>()), databaseApi: api }));

import { forgetQuery, readQuery, updateQuery } from "../queryState";
import { QueryWorkspace } from "./QueryWorkspace";

const shop: DatabaseProfile = {
    id: "p1",
    name: "Shop",
    readOnly: true,
    agentWrites: false,
    hasPassword: false,
    engine: "postgres",
    host: "localhost",
    port: null,
    database: "shop",
    user: "app",
    tls: "prefer",
};

const rows = {
    results: [{ columns: [{ name: "n", type: "int8", numeric: true }], rows: [[3]], truncated: false, affected: null }],
    millis: 7,
};

afterEach(() => {
    cleanup();
    forgetQuery("p1");
});
beforeEach(() => {
    api.query.mockReset();
    api.cancel.mockReset();
});

describe("QueryWorkspace", () => {
    it("asks for SQL before anything has run, and keeps Run off while the editor is empty", () => {
        render(<QueryWorkspace profile={shop} />);
        expect(screen.getByText(/press ⌘↵ to run the statement under the cursor/)).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Run" })).toBeDisabled();
        expect(screen.getByText("Read only")).toBeInTheDocument();
    });

    it("runs everything in the editor and shows the results", async () => {
        api.query.mockResolvedValue(rows);
        updateQuery("p1", { sql: "select count(*) as n from orders" });
        render(<QueryWorkspace profile={shop} />);
        await act(async () => fireEvent.click(screen.getByRole("button", { name: "Run" })));
        expect(api.query).toHaveBeenCalledWith("p1", "select count(*) as n from orders", 500);
        expect(screen.getByRole("status")).toHaveTextContent("1 row · 7 ms");
    });

    it("shows the database's error in place of results", async () => {
        api.query.mockRejectedValue({ category: "query", message: 'syntax error at or near "selec"' });
        updateQuery("p1", { sql: "selec 1" });
        render(<QueryWorkspace profile={shop} />);
        await act(async () => fireEvent.click(screen.getByRole("button", { name: "Run" })));
        expect(screen.getByRole("alert")).toHaveTextContent('syntax error at or near "selec"');
    });

    it("offers Stop while a query runs", async () => {
        api.query.mockReturnValue(new Promise(() => {}));
        api.cancel.mockResolvedValue(undefined);
        updateQuery("p1", { sql: "select pg_sleep(60)" });
        render(<QueryWorkspace profile={shop} />);
        await act(async () => fireEvent.click(screen.getByRole("button", { name: "Run" })));
        expect(screen.getByRole("button", { name: "Running…" })).toBeDisabled();
        await act(async () => fireEvent.click(screen.getByRole("button", { name: "Stop" })));
        expect(api.cancel).toHaveBeenCalledWith("p1");
        updateQuery("p1", { running: false });
    });

    it("remembers the row limit picked", () => {
        render(<QueryWorkspace profile={shop} />);
        updateQuery("p1", { limit: 1000 });
        expect(readQuery("p1").limit).toBe(1000);
    });
});

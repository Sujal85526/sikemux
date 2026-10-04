import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseProfile, ResultSet } from "../api";

vi.mock("../../../plugin-api/ui", async (importOriginal) => ({
    ...(await importOriginal<object>()),
    SendToAgentMenu: ({ delivery }: { delivery: () => { text?: string } }) => <pre data-testid="send-menu">{delivery().text}</pre>,
}));

import { SendResults } from "./SendResults";

const shop: DatabaseProfile = { id: "p1", name: "Shop", readOnly: false, agentWrites: false, hasPassword: false, engine: "sqlite", path: "/a.db" };
const result: ResultSet = { columns: [{ name: "n", type: "", numeric: true }], rows: [[2]], truncated: false, affected: null };

afterEach(cleanup);

describe("SendResults", () => {
    it("hands an agent the database, the SQL and the results", () => {
        render(<SendResults profile={shop} sql="select count(*) as n from orders" result={result} />);
        expect(screen.queryByTestId("send-menu")).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Send to agent" }));
        const sent = screen.getByTestId("send-menu").textContent ?? "";
        expect(sent).toContain('SQLite database "Shop"');
        expect(sent).toContain("select count(*) as n from orders");
        expect(sent).toContain("| 2 |");
    });
});

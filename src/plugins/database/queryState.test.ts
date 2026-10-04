import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ query: vi.fn(), cancel: vi.fn() }));
vi.mock("./api", async (importOriginal) => ({ ...(await importOriginal<object>()), databaseApi: api }));

import { forgetQuery, loadQuery, readQuery, runQuery, stopQuery, updateQuery } from "./queryState";

const outcome = { results: [{ columns: [], rows: [], truncated: false, affected: 1 }], millis: 4 };

afterEach(() => {
    forgetQuery("p1");
    api.query.mockReset();
    api.cancel.mockReset();
});

describe("queryState", () => {
    it("runs the SQL with the chosen row limit and keeps what came back", async () => {
        api.query.mockResolvedValue(outcome);
        updateQuery("p1", { limit: 100 });
        await runQuery("p1", "  update t set a = 1  ");
        expect(api.query).toHaveBeenCalledWith("p1", "update t set a = 1", 100);
        expect(readQuery("p1")).toMatchObject({ outcome, error: null, running: false, ran: "update t set a = 1" });
    });

    it("keeps the database's own error and clears the old result", async () => {
        api.query.mockResolvedValueOnce(outcome).mockRejectedValueOnce({ category: "query", message: 'relation "t" does not exist' });
        await runQuery("p1", "select 1");
        await runQuery("p1", "select * from t");
        expect(readQuery("p1")).toMatchObject({ outcome: null, error: 'relation "t" does not exist', running: false });
    });

    it("does not start a second run while one is going, nor run empty SQL", async () => {
        let finish: (value: unknown) => void = () => {};
        api.query.mockReturnValue(new Promise((resolve) => (finish = resolve)));
        const first = runQuery("p1", "select pg_sleep(10)");
        await runQuery("p1", "select 2");
        await runQuery("p1", "   ");
        expect(api.query).toHaveBeenCalledTimes(1);
        expect(readQuery("p1").running).toBe(true);
        finish(outcome);
        await first;
        expect(readQuery("p1").running).toBe(false);
    });

    it("stops a run and loads SQL without running it", async () => {
        api.cancel.mockResolvedValue(undefined);
        await stopQuery("p1");
        expect(api.cancel).toHaveBeenCalledWith("p1");
        loadQuery("p1", "select * from orders limit 100;");
        expect(readQuery("p1").sql).toBe("select * from orders limit 100;");
        expect(api.query).not.toHaveBeenCalled();
    });
});

import { describe, expect, it } from "vitest";
import { evaluateAssertions, evaluateExpression, runScript, type SandboxCtx } from "./sandbox";

function ctx(): SandboxCtx {
    return {
        vars: { token: "old" },
        req: { method: "GET", url: "https://example.test", headers: {}, body: null, name: "request" },
        res: { status: 200, statusText: "OK", headers: { "content-type": "application/json" }, body: { ok: true, items: [1, 2] }, responseTime: 42 },
        logs: [],
        tests: [],
    };
}

describe("Bruno script sandbox", () => {
    it("runs pre/post scripts against the Bruno-compatible API", async () => {
        const c = ctx();
        await runScript(
            `
            bru.setVar("token", "new");
            req.setHeader("X-Test", bru.getVar("token"));
            console.log(req.getUrl());
            test("status ok", () => expect(res.getStatus()).to.equal(200));
            test("async pass", async () => expect(res.body.items).to.have.length(2));
            `,
            c,
        );

        expect(c.vars.token).toBe("new");
        expect(c.req.headers["X-Test"]).toBe("new");
        expect(c.logs).toEqual([{ level: "log", text: "https://example.test" }]);
        expect(c.tests).toEqual([
            { name: "status ok", passed: true },
            { name: "async pass", passed: true },
        ]);
    });

    it("evaluates expressions and assertion rows", () => {
        const c = ctx();
        expect(evaluateExpression("res.status", { res: c.res, req: c.req, bru: {} })).toBe(200);
        evaluateAssertions(
            [
                { name: "res.status", value: "eq 200", enabled: true },
                { name: "res.body.items", value: "length 2", enabled: true },
                { name: "req.method", value: "eq POST", enabled: true },
                { name: "ignored", value: "eq anything", enabled: false },
            ],
            { res: c.res, req: c.req, bru: {} },
            c.tests,
        );

        expect(c.tests).toHaveLength(3);
        expect(c.tests[0]).toMatchObject({ passed: true });
        expect(c.tests[1]).toMatchObject({ passed: true });
        expect(c.tests[2].passed).toBe(false);
        expect(c.tests[2].error).toContain("POST");
    });
});

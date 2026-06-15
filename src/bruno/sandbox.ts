// Pre/post-request script + assertion sandbox.
//
// Scripts run in the webview's own JS engine — no second runtime — via a
// constructed async function with the Bruno-compatible `bru` / `req` / `res` /
// `expect` / `test` / `console` API injected. Network calls (bru.sendRequest)
// route to the Rust HTTP command. Scripts come from the user's own .bru files,
// so this is a convenience sandbox (timeout-guarded), not a security boundary.

import { brunoApi, type BruSendRequest } from "../api/bruno";
import type { Scope } from "./interpolate";

export interface ScriptLog {
    level: string;
    text: string;
}
export interface TestResult {
    name: string;
    passed: boolean;
    error?: string;
}

export interface ReqView {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: unknown;
    name: string;
}
export interface ResView {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: unknown;
    responseTime: number;
}

export interface SandboxCtx {
    vars: Scope;
    req: ReqView;
    res?: ResView;
    logs: ScriptLog[];
    tests: TestResult[];
}

const SCRIPT_TIMEOUT_MS = 15_000;

function fmt(v: unknown): string {
    if (typeof v === "string") return v;
    try {
        return JSON.stringify(v);
    } catch {
        return String(v);
    }
}

function errMsg(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

function typeName(v: unknown): string {
    if (v === null) return "null";
    if (Array.isArray(v)) return "array";
    return typeof v;
}

function deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (typeof a !== typeof b || a == null || b == null) return false;
    if (typeof a !== "object") return false;
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ak = Object.keys(ao);
    const bk = Object.keys(bo);
    if (ak.length !== bk.length) return false;
    return ak.every((k) => deepEqual(ao[k], bo[k]));
}

function includes(actual: unknown, v: unknown): boolean {
    if (typeof actual === "string") return actual.includes(String(v));
    if (Array.isArray(actual)) return actual.includes(v);
    if (actual && typeof actual === "object") return String(v) in (actual as object);
    return false;
}

function isEmpty(v: unknown): boolean {
    if (v == null) return true;
    if (typeof v === "string" || Array.isArray(v)) return v.length === 0;
    if (typeof v === "object") return Object.keys(v as object).length === 0;
    return false;
}

/** A compact chai-like expect supporting the chains common in Bruno test scripts. */
function makeExpect() {
    const make = (actual: unknown, negated: boolean): unknown => {
        const ok = (cond: boolean, msg: string) => {
            if (negated ? cond : !cond) throw new Error(msg);
        };
        const fns: Record<string, (...a: never[]) => void> = {
            equal: ((v: unknown) => ok(actual === v, `expected ${fmt(actual)} to equal ${fmt(v)}`)) as never,
            eql: ((v: unknown) => ok(deepEqual(actual, v), `expected ${fmt(actual)} to deeply equal ${fmt(v)}`)) as never,
            above: ((v: number) => ok(Number(actual) > v, `expected ${fmt(actual)} to be above ${v}`)) as never,
            least: ((v: number) => ok(Number(actual) >= v, `expected ${fmt(actual)} to be >= ${v}`)) as never,
            below: ((v: number) => ok(Number(actual) < v, `expected ${fmt(actual)} to be below ${v}`)) as never,
            most: ((v: number) => ok(Number(actual) <= v, `expected ${fmt(actual)} to be <= ${v}`)) as never,
            include: ((v: unknown) => ok(includes(actual, v), `expected ${fmt(actual)} to include ${fmt(v)}`)) as never,
            contain: ((v: unknown) => ok(includes(actual, v), `expected ${fmt(actual)} to contain ${fmt(v)}`)) as never,
            a: ((t: string) => ok(typeName(actual) === t, `expected ${fmt(actual)} to be a ${t}`)) as never,
            an: ((t: string) => ok(typeName(actual) === t, `expected ${fmt(actual)} to be an ${t}`)) as never,
            property: ((k: string) => ok(actual != null && k in Object(actual), `expected property ${k}`)) as never,
            match: ((re: RegExp) => ok(re.test(String(actual)), `expected ${fmt(actual)} to match ${re}`)) as never,
            status: ((v: number) => {
                const s = actual && typeof actual === "object" && "status" in actual ? (actual as { status: number }).status : actual;
                ok(s === v, `expected status ${fmt(s)} to be ${v}`);
            }) as never,
            length: ((v: number) => ok((actual as { length?: number })?.length === v, `expected length ${v}`)) as never,
        };
        const getters: Record<string, () => void> = {
            ok: () => ok(!!actual, `expected ${fmt(actual)} to be truthy`),
            exist: () => ok(actual != null, `expected ${fmt(actual)} to exist`),
            empty: () => ok(isEmpty(actual), `expected ${fmt(actual)} to be empty`),
            true: () => ok(actual === true, `expected true`),
            false: () => ok(actual === false, `expected false`),
            null: () => ok(actual === null, `expected null`),
            undefined: () => ok(actual === undefined, `expected undefined`),
        };
        const PASS = new Set(["to", "be", "been", "is", "that", "which", "and", "has", "have", "with", "at", "of", "the", "same", "deep"]);
        return new Proxy(
            {},
            {
                get(_t, prop: string) {
                    if (prop === "not") return make(actual, !negated);
                    if (prop in fns) return fns[prop];
                    if (prop in getters) {
                        getters[prop]();
                        return undefined;
                    }
                    if (PASS.has(prop)) return make(actual, negated);
                    return make(actual, negated);
                },
            },
        );
    };
    return (actual: unknown) => make(actual, false);
}

function makeBru(ctx: SandboxCtx) {
    const get = (k: string) => ctx.vars[k];
    const set = (k: string, v: unknown) => {
        ctx.vars[k] = v == null ? "" : String(v);
    };
    return {
        getEnvVar: get,
        setEnvVar: set,
        getVar: get,
        setVar: set,
        getCollectionVar: get,
        getProcessEnv: (k: string) => ctx.vars[`process.env.${k}`] ?? "",
        setNextRequest: (_: string) => {},
        sendRequest: async (opts: { url: string; method?: string; headers?: Record<string, unknown>; data?: unknown }) => {
            const headers: [string, string][] = Object.entries(opts.headers ?? {}).map(([k, v]) => [k, String(v)]);
            const data = opts.data;
            const body =
                data == null
                    ? ({ kind: "none" } as const)
                    : typeof data === "string"
                      ? ({ kind: "raw", content_type: null, data } as const)
                      : ({ kind: "raw", content_type: "application/json", data: JSON.stringify(data) } as const);
            const r = await brunoApi.send({ method: (opts.method ?? "GET").toUpperCase(), url: opts.url, headers, body, timeout_ms: 0, skip_tls_verify: false });
            let parsed: unknown = r.body;
            try {
                parsed = JSON.parse(r.body);
            } catch {
                /* keep raw */
            }
            return { status: r.status, statusText: r.status_text, headers: Object.fromEntries(r.headers), data: parsed };
        },
    };
}

function makeReq(ctx: SandboxCtx) {
    const r = ctx.req;
    return {
        getUrl: () => r.url,
        setUrl: (u: string) => {
            r.url = u;
        },
        getMethod: () => r.method,
        setMethod: (m: string) => {
            r.method = m;
        },
        getHeaders: () => r.headers,
        getHeader: (k: string) => r.headers[k],
        setHeader: (k: string, v: string) => {
            r.headers[k] = v;
        },
        getBody: () => r.body,
        setBody: (b: unknown) => {
            r.body = b;
        },
        getName: () => r.name,
    };
}

function makeRes(ctx: SandboxCtx) {
    const r = ctx.res as ResView;
    return {
        get status() {
            return r.status;
        },
        get body() {
            return r.body;
        },
        get headers() {
            return r.headers;
        },
        get responseTime() {
            return r.responseTime;
        },
        getStatus: () => r.status,
        getBody: () => r.body,
        getHeader: (k: string) => r.headers[k],
        getHeaders: () => r.headers,
        getResponseTime: () => r.responseTime,
    };
}

async function runScriptInline(code: string, ctx: SandboxCtx): Promise<void> {
    if (!code.trim()) return;
    const bru = makeBru(ctx);
    const req = makeReq(ctx);
    const res = ctx.res ? makeRes(ctx) : undefined;
    const expect = makeExpect();
    const pending: Promise<void>[] = [];
    const test = (name: string, fn: () => unknown) => {
        try {
            const r = fn();
            if (r && typeof (r as Promise<unknown>).then === "function") {
                pending.push(
                    (r as Promise<unknown>).then(
                        () => void ctx.tests.push({ name, passed: true }),
                        (e: unknown) => void ctx.tests.push({ name, passed: false, error: errMsg(e) }),
                    ),
                );
            } else {
                ctx.tests.push({ name, passed: true });
            }
        } catch (e) {
            ctx.tests.push({ name, passed: false, error: errMsg(e) });
        }
    };
    const log =
        (level: string) =>
        (...args: unknown[]) =>
            ctx.logs.push({ level, text: args.map(fmt).join(" ") });
    const consoleShim = { log: log("log"), info: log("info"), warn: log("warn"), error: log("error"), debug: log("debug") };

    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function("bru", "req", "res", "expect", "test", "console", `return (async () => {\n${code}\n})();`);
    const exec = Promise.resolve(fn(bru, req, res, expect, test, consoleShim));
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("script timed out")), SCRIPT_TIMEOUT_MS));
    try {
        await Promise.race([exec, timeout]);
        await Promise.all(pending);
    } catch (e) {
        ctx.logs.push({ level: "error", text: `script error: ${errMsg(e)}` });
    }
}

const WORKER_SOURCE = String.raw`
const pending = new Map();

function fmt(v) {
    if (typeof v === "string") return v;
    try { return JSON.stringify(v); } catch { return String(v); }
}
function errMsg(e) {
    return e && typeof e === "object" && typeof e.message === "string" ? e.message : String(e);
}
function typeName(v) {
    if (v === null) return "null";
    if (Array.isArray(v)) return "array";
    return typeof v;
}
function deepEqual(a, b) {
    if (a === b) return true;
    if (typeof a !== typeof b || a == null || b == null) return false;
    if (typeof a !== "object") return false;
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    return ak.every((k) => deepEqual(a[k], b[k]));
}
function includes(actual, v) {
    if (typeof actual === "string") return actual.includes(String(v));
    if (Array.isArray(actual)) return actual.includes(v);
    if (actual && typeof actual === "object") return String(v) in actual;
    return false;
}
function isEmpty(v) {
    if (v == null) return true;
    if (typeof v === "string" || Array.isArray(v)) return v.length === 0;
    if (typeof v === "object") return Object.keys(v).length === 0;
    return false;
}
function makeExpect() {
    const make = (actual, negated) => {
        const ok = (cond, msg) => {
            if (negated ? cond : !cond) throw new Error(msg);
        };
        const fns = {
            equal: (v) => ok(actual === v, "expected " + fmt(actual) + " to equal " + fmt(v)),
            eql: (v) => ok(deepEqual(actual, v), "expected " + fmt(actual) + " to deeply equal " + fmt(v)),
            above: (v) => ok(Number(actual) > v, "expected " + fmt(actual) + " to be above " + v),
            least: (v) => ok(Number(actual) >= v, "expected " + fmt(actual) + " to be >= " + v),
            below: (v) => ok(Number(actual) < v, "expected " + fmt(actual) + " to be below " + v),
            most: (v) => ok(Number(actual) <= v, "expected " + fmt(actual) + " to be <= " + v),
            include: (v) => ok(includes(actual, v), "expected " + fmt(actual) + " to include " + fmt(v)),
            contain: (v) => ok(includes(actual, v), "expected " + fmt(actual) + " to contain " + fmt(v)),
            a: (t) => ok(typeName(actual) === t, "expected " + fmt(actual) + " to be a " + t),
            an: (t) => ok(typeName(actual) === t, "expected " + fmt(actual) + " to be an " + t),
            property: (k) => ok(actual != null && k in Object(actual), "expected property " + k),
            match: (re) => ok(re.test(String(actual)), "expected " + fmt(actual) + " to match " + re),
            status: (v) => {
                const s = actual && typeof actual === "object" && "status" in actual ? actual.status : actual;
                ok(s === v, "expected status " + fmt(s) + " to be " + v);
            },
            length: (v) => ok(actual && actual.length === v, "expected length " + v),
        };
        const getters = {
            ok: () => ok(!!actual, "expected " + fmt(actual) + " to be truthy"),
            exist: () => ok(actual != null, "expected " + fmt(actual) + " to exist"),
            empty: () => ok(isEmpty(actual), "expected " + fmt(actual) + " to be empty"),
            true: () => ok(actual === true, "expected true"),
            false: () => ok(actual === false, "expected false"),
            null: () => ok(actual === null, "expected null"),
            undefined: () => ok(actual === undefined, "expected undefined"),
        };
        const pass = new Set(["to", "be", "been", "is", "that", "which", "and", "has", "have", "with", "at", "of", "the", "same", "deep"]);
        return new Proxy({}, {
            get(_t, prop) {
                if (prop === "not") return make(actual, !negated);
                if (prop in fns) return fns[prop];
                if (prop in getters) {
                    getters[prop]();
                    return undefined;
                }
                if (pass.has(prop)) return make(actual, negated);
                return make(actual, negated);
            },
        });
    };
    return (actual) => make(actual, false);
}
function sendRequest(req) {
    const id = Math.random().toString(36).slice(2);
    self.postMessage({ type: "sendRequest", id, req });
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
function makeBru(ctx) {
    const get = (k) => ctx.vars[k];
    const set = (k, v) => {
        ctx.vars[k] = v == null ? "" : String(v);
    };
    return {
        getEnvVar: get,
        setEnvVar: set,
        getVar: get,
        setVar: set,
        getCollectionVar: get,
        getProcessEnv: (k) => ctx.vars["process.env." + k] || "",
        setNextRequest: (_) => {},
        sendRequest: async (opts) => {
            const headers = Object.entries(opts.headers || {}).map(([k, v]) => [k, String(v)]);
            const data = opts.data;
            const body = data == null
                ? { kind: "none" }
                : typeof data === "string"
                  ? { kind: "raw", content_type: null, data }
                  : { kind: "raw", content_type: "application/json", data: JSON.stringify(data) };
            const r = await sendRequest({ method: (opts.method || "GET").toUpperCase(), url: opts.url, headers, body, timeout_ms: 0, skip_tls_verify: false });
            let parsed = r.body;
            try { parsed = JSON.parse(r.body); } catch {}
            return { status: r.status, statusText: r.status_text, headers: Object.fromEntries(r.headers), data: parsed };
        },
    };
}
function makeReq(ctx) {
    const r = ctx.req;
    return {
        getUrl: () => r.url,
        setUrl: (u) => { r.url = u; },
        getMethod: () => r.method,
        setMethod: (m) => { r.method = m; },
        getHeaders: () => r.headers,
        getHeader: (k) => r.headers[k],
        setHeader: (k, v) => { r.headers[k] = v; },
        getBody: () => r.body,
        setBody: (b) => { r.body = b; },
        getName: () => r.name,
    };
}
function makeRes(ctx) {
    const r = ctx.res;
    return {
        get status() { return r.status; },
        get body() { return r.body; },
        get headers() { return r.headers; },
        get responseTime() { return r.responseTime; },
        getStatus: () => r.status,
        getBody: () => r.body,
        getHeader: (k) => r.headers[k],
        getHeaders: () => r.headers,
        getResponseTime: () => r.responseTime,
    };
}
async function run(code, ctx) {
    const bru = makeBru(ctx);
    const req = makeReq(ctx);
    const res = ctx.res ? makeRes(ctx) : undefined;
    const expect = makeExpect();
    const pendingTests = [];
    const test = (name, fn) => {
        try {
            const r = fn();
            if (r && typeof r.then === "function") {
                pendingTests.push(r.then(
                    () => ctx.tests.push({ name, passed: true }),
                    (e) => ctx.tests.push({ name, passed: false, error: errMsg(e) }),
                ));
            } else {
                ctx.tests.push({ name, passed: true });
            }
        } catch (e) {
            ctx.tests.push({ name, passed: false, error: errMsg(e) });
        }
    };
    const log = (level) => (...args) => ctx.logs.push({ level, text: args.map(fmt).join(" ") });
    const consoleShim = { log: log("log"), info: log("info"), warn: log("warn"), error: log("error"), debug: log("debug") };
    try {
        const fn = new Function("bru", "req", "res", "expect", "test", "console", "return (async () => {\n" + code + "\n})();");
        await Promise.resolve(fn(bru, req, res, expect, test, consoleShim));
        await Promise.all(pendingTests);
    } catch (e) {
        ctx.logs.push({ level: "error", text: "script error: " + errMsg(e) });
    }
}
self.onmessage = (event) => {
    const msg = event.data;
    if (msg.type === "sendResponse") {
        const entry = pending.get(msg.id);
        if (!entry) return;
        pending.delete(msg.id);
        if (msg.ok) entry.resolve(msg.response);
        else entry.reject(new Error(msg.error || "request failed"));
        return;
    }
    if (msg.type !== "start") return;
    const ctx = { vars: msg.ctx.vars, req: msg.ctx.req, res: msg.ctx.res, logs: [], tests: [] };
    run(msg.code, ctx).then(
        () => self.postMessage({ type: "done", vars: ctx.vars, req: ctx.req, logs: ctx.logs, tests: ctx.tests }),
        (e) => self.postMessage({ type: "done", vars: ctx.vars, req: ctx.req, logs: [{ level: "error", text: "script error: " + errMsg(e) }], tests: ctx.tests }),
    );
};
`;

function replaceScope(target: Scope, next: Scope): void {
    for (const key of Object.keys(target)) delete target[key];
    Object.assign(target, next);
}

function replaceReq(target: ReqView, next: ReqView): void {
    target.method = next.method;
    target.url = next.url;
    target.headers = next.headers;
    target.body = next.body;
    target.name = next.name;
}

interface WorkerDone {
    type: "done";
    vars: Scope;
    req: ReqView;
    logs: ScriptLog[];
    tests: TestResult[];
}

interface WorkerSendRequest {
    type: "sendRequest";
    id: string;
    req: BruSendRequest;
}

type WorkerMessage = WorkerDone | WorkerSendRequest;

function isWorkerAvailable(): boolean {
    return typeof Worker !== "undefined" && typeof Blob !== "undefined" && typeof URL !== "undefined";
}

export async function runScript(code: string, ctx: SandboxCtx): Promise<void> {
    if (!code.trim()) return;
    if (!isWorkerAvailable()) {
        await runScriptInline(code, ctx);
        return;
    }

    const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" }));
    const worker = new Worker(url);
    let settled = false;

    await new Promise<void>((resolve) => {
        const finish = (err?: string) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            worker.terminate();
            URL.revokeObjectURL(url);
            if (err) ctx.logs.push({ level: "error", text: `script error: ${err}` });
            resolve();
        };

        const timeout = setTimeout(() => finish("script timed out"), SCRIPT_TIMEOUT_MS);

        worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
            const msg = event.data;
            if (msg.type === "sendRequest") {
                void brunoApi.send(msg.req).then(
                    (response) => worker.postMessage({ type: "sendResponse", id: msg.id, ok: true, response }),
                    (e: unknown) => worker.postMessage({ type: "sendResponse", id: msg.id, ok: false, error: errMsg(e) }),
                );
                return;
            }
            replaceScope(ctx.vars, msg.vars);
            replaceReq(ctx.req, msg.req);
            ctx.logs.push(...msg.logs);
            ctx.tests.push(...msg.tests);
            finish();
        };
        worker.onerror = (event) => finish(event.message || "worker error");
        worker.postMessage({
            type: "start",
            code,
            ctx: {
                vars: { ...ctx.vars },
                req: { ...ctx.req, headers: { ...ctx.req.headers } },
                res: ctx.res ? { ...ctx.res, headers: { ...ctx.res.headers } } : undefined,
            },
        });
    });
}

const ASSERT_OPS = new Set([
    "eq",
    "neq",
    "gt",
    "gte",
    "lt",
    "lte",
    "in",
    "notIn",
    "contains",
    "notContains",
    "length",
    "matches",
    "notMatches",
    "startsWith",
    "endsWith",
    "between",
    "isEmpty",
    "notEmpty",
    "isNull",
    "isUndefined",
    "isDefined",
    "isTruthy",
    "isFalsy",
    "isJson",
    "isNumber",
    "isString",
    "isBoolean",
    "isArray",
]);

function coerce(s: string): unknown {
    const t = s.trim();
    if (t === "") return "";
    try {
        return JSON.parse(t);
    } catch {
        return t.replace(/^['"]|['"]$/g, "");
    }
}

export function evaluateExpression(expr: string, env: { res?: ResView; req: ReqView; bru: Record<string, unknown> }): unknown {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    return new Function("res", "req", "bru", `return (${expr});`)(env.res, env.req, env.bru);
}

function compare(actual: unknown, op: string, expectedRaw: string): { passed: boolean; error?: string } {
    const expected = coerce(expectedRaw);
    const num = Number(actual);
    const fail = (msg: string) => ({ passed: false, error: msg });
    const pass = { passed: true };
    switch (op) {
        case "eq":
            return actual == expected ? pass : fail(`expected ${fmt(actual)} == ${fmt(expected)}`);
        case "neq":
            return actual != expected ? pass : fail(`expected ${fmt(actual)} != ${fmt(expected)}`);
        case "gt":
            return num > Number(expected) ? pass : fail(`expected ${fmt(actual)} > ${fmt(expected)}`);
        case "gte":
            return num >= Number(expected) ? pass : fail(`expected ${fmt(actual)} >= ${fmt(expected)}`);
        case "lt":
            return num < Number(expected) ? pass : fail(`expected ${fmt(actual)} < ${fmt(expected)}`);
        case "lte":
            return num <= Number(expected) ? pass : fail(`expected ${fmt(actual)} <= ${fmt(expected)}`);
        case "contains":
            return includes(actual, expected) ? pass : fail(`expected ${fmt(actual)} to contain ${fmt(expected)}`);
        case "notContains":
            return !includes(actual, expected) ? pass : fail(`expected ${fmt(actual)} not to contain ${fmt(expected)}`);
        case "in":
            return Array.isArray(expected) && expected.includes(actual) ? pass : fail(`expected ${fmt(actual)} in ${fmt(expected)}`);
        case "notIn":
            return Array.isArray(expected) && !expected.includes(actual) ? pass : fail(`expected ${fmt(actual)} not in ${fmt(expected)}`);
        case "length":
            return (actual as { length?: number })?.length === Number(expected) ? pass : fail(`expected length ${fmt(expected)}`);
        case "matches":
            return new RegExp(String(expected)).test(String(actual)) ? pass : fail(`expected ${fmt(actual)} to match ${fmt(expected)}`);
        case "notMatches":
            return !new RegExp(String(expected)).test(String(actual)) ? pass : fail(`expected ${fmt(actual)} not to match ${fmt(expected)}`);
        case "startsWith":
            return String(actual).startsWith(String(expected)) ? pass : fail(`expected ${fmt(actual)} to start with ${fmt(expected)}`);
        case "endsWith":
            return String(actual).endsWith(String(expected)) ? pass : fail(`expected ${fmt(actual)} to end with ${fmt(expected)}`);
        case "isEmpty":
            return isEmpty(actual) ? pass : fail(`expected ${fmt(actual)} to be empty`);
        case "notEmpty":
            return !isEmpty(actual) ? pass : fail(`expected ${fmt(actual)} not to be empty`);
        case "isNull":
            return actual === null ? pass : fail(`expected null`);
        case "isUndefined":
            return actual === undefined ? pass : fail(`expected undefined`);
        case "isDefined":
            return actual !== undefined ? pass : fail(`expected defined`);
        case "isTruthy":
            return actual ? pass : fail(`expected truthy`);
        case "isFalsy":
            return !actual ? pass : fail(`expected falsy`);
        case "isNumber":
            return typeof actual === "number" ? pass : fail(`expected number`);
        case "isString":
            return typeof actual === "string" ? pass : fail(`expected string`);
        case "isBoolean":
            return typeof actual === "boolean" ? pass : fail(`expected boolean`);
        case "isArray":
            return Array.isArray(actual) ? pass : fail(`expected array`);
        case "between": {
            const parts = expectedRaw.trim().split(/\s+/).map(Number);
            return num >= parts[0] && num <= parts[1] ? pass : fail(`expected ${fmt(actual)} between ${parts[0]} and ${parts[1]}`);
        }
        default:
            return actual == expected ? pass : fail(`expected ${fmt(actual)} == ${fmt(expected)}`);
    }
}

/** Evaluate `assert` rows: lhs is a JS expression over res/req/bru, rhs is `<op> <expected>`. */
export function evaluateAssertions(
    rows: { name: string; value: string; enabled: boolean }[],
    env: { res?: ResView; req: ReqView; bru: Record<string, unknown> },
    tests: TestResult[],
): void {
    for (const a of rows) {
        if (!a.enabled || !a.name.trim()) continue;
        const raw = a.value.trim();
        const sp = raw.split(/\s+/);
        const op = ASSERT_OPS.has(sp[0]) ? sp[0] : "eq";
        const expectedRaw = ASSERT_OPS.has(sp[0]) ? sp.slice(1).join(" ") : raw;
        let actual: unknown;
        try {
            actual = evaluateExpression(a.name, env);
        } catch (e) {
            tests.push({ name: `${a.name} ${raw}`, passed: false, error: `eval error: ${errMsg(e)}` });
            continue;
        }
        const { passed, error } = compare(actual, op, expectedRaw);
        tests.push({ name: `${a.name} ${raw}`, passed, error });
    }
}

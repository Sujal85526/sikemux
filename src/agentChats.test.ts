import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import { agentApi, type AgentInfo, type AgentSession } from "./api/agents";
import {
    agentChatSearchCorpus,
    aggregateAgentChatLoadState,
    mergeAgentChatLoadSummaries,
    normalizeAgentChats,
    searchAgentChats,
    sortAgentChatsByRecent,
    type AgentChatProviderLoad,
} from "./agentChats";

const codex: AgentInfo = { type: "codex", label: "Codex", command: "codex" };
const claude: AgentInfo = { type: "claude", label: "Claude", command: "claude" };

function success(provider: AgentInfo, sessions: AgentSession[]): Extract<AgentChatProviderLoad, { status: "success" }> {
    return { provider, status: "success", sessions };
}

beforeEach(() => {
    mocks.invoke.mockReset();
});

describe("multi-provider agent history API", () => {
    it("keeps provider order and converts provider failures to opaque results", async () => {
        mocks.invoke.mockImplementation((_command: string, args: { agent: string }) => {
            if (args.agent === "claude") return Promise.reject(new Error("private filesystem detail"));
            return Promise.resolve([{ id: "codex-chat", title: "Codex chat", mtime: 3 }]);
        });

        const results = await agentApi.sessionResults([claude, codex], "/repo");

        expect(results).toEqual([
            { provider: claude, status: "error", sessions: [] },
            {
                provider: codex,
                status: "success",
                sessions: [{ id: "codex-chat", title: "Codex chat", mtime: 3 }],
            },
        ]);
        expect(JSON.stringify(results)).not.toContain("private filesystem detail");
    });
});

describe("agent chat normalization and search", () => {
    it("normalizes titles, drops invalid ids, de-duplicates, and keeps a stable recent order", () => {
        const rows = normalizeAgentChats(
            [
                success(codex, [
                    { id: "older", title: "  First\nchat  ", mtime: 20.9 },
                    { id: "same-time-a", title: "", mtime: 30 },
                    { id: "duplicate", title: "Old duplicate", mtime: 10 },
                    { id: " ", title: "Invalid", mtime: 100 },
                ]),
                success(claude, [{ id: "same-time-b", title: "Claude chat", mtime: 30 }]),
                success(codex, [{ id: "duplicate", title: "Fresh duplicate", mtime: 40 }]),
            ],
            "/code/sikemux",
        );

        expect(rows.map((row) => row.id)).toEqual(["duplicate", "same-time-a", "same-time-b", "older"]);
        expect(rows[0]).toMatchObject({ title: "Fresh duplicate", mtime: 40, type: "codex" });
        expect(rows[1].title).toBe("Untitled chat");
        expect(rows[3].title).toBe("First chat");
        expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
    });

    it("searches title, provider, session id, and workspace while retaining recent order for blank queries", () => {
        const rows = normalizeAgentChats(
            [
                success(codex, [{ id: "thread-needle", title: "Fix parser", mtime: 30 }]),
                success(claude, [{ id: "other", title: "Write release notes", mtime: 40 }]),
            ],
            "/code/sikemux",
        );

        expect(searchAgentChats(rows, "parser").map((row) => row.id)).toEqual(["thread-needle"]);
        expect(searchAgentChats(rows, "codex").map((row) => row.id)).toEqual(["thread-needle"]);
        expect(searchAgentChats(rows, "parser codex").map((row) => row.id)).toEqual(["thread-needle"]);
        expect(searchAgentChats(rows, "needle").map((row) => row.id)).toEqual(["thread-needle"]);
        expect(searchAgentChats(rows, "sikemux")).toHaveLength(2);
        expect(searchAgentChats([...rows].reverse(), "").map((row) => row.id)).toEqual(["other", "thread-needle"]);
        expect(agentChatSearchCorpus(rows[0])).toContain("/code/sikemux");
    });

    it("preserves source order for equal timestamps", () => {
        const rows = normalizeAgentChats(
            [
                success(
                    codex,
                    ["one", "two", "three"].map((id) => ({ id, title: id, mtime: 10 })),
                ),
            ],
            "/repo",
        );
        expect(sortAgentChatsByRecent(rows).map((row) => row.id)).toEqual(["one", "two", "three"]);
    });
});

describe("agent chat loading aggregation", () => {
    it.each([
        {
            expected: "detecting",
            input: { detecting: true, cwd: "/repo", providers: [] },
        },
        {
            expected: "history-loading",
            input: { detecting: false, cwd: "/repo", providers: [{ provider: codex, status: "loading" as const }] },
        },
        {
            expected: "ready",
            input: {
                detecting: false,
                cwd: "/repo",
                providers: [success(codex, [{ id: "one", title: "One", mtime: 1 }])],
            },
        },
        {
            expected: "empty",
            input: { detecting: false, cwd: "/repo", providers: [success(codex, [])] },
        },
        {
            expected: "partial-error",
            input: {
                detecting: false,
                cwd: "/repo",
                providers: [success(codex, []), { provider: claude, status: "error" as const, sessions: [] as [] }],
            },
        },
        {
            expected: "partial-error",
            input: { detecting: false, detectionFailed: true, cwd: "/repo", providers: [] },
        },
    ])("reports $expected", ({ input, expected }) => {
        expect(aggregateAgentChatLoadState(input).phase).toBe(expected);
    });

    it("accounts for every provider without exposing raw errors", () => {
        const summary = aggregateAgentChatLoadState({
            detecting: false,
            cwd: "/repo",
            providers: [success(codex, [{ id: "one", title: "One", mtime: 1 }]), { provider: claude, status: "error", sessions: [] }],
        });

        expect(summary).toMatchObject({
            phase: "partial-error",
            providerCount: 2,
            loadingProviderCount: 0,
            successfulProviderCount: 1,
            failedProviderCount: 1,
            providerErrors: [{ type: "claude", label: "Claude" }],
        });
        expect(summary.providerErrors[0]).toEqual({ type: "claude", label: "Claude" });
        expect(summary.providerErrors[0]).not.toHaveProperty("error");
        expect(summary.providerErrors[0]).not.toHaveProperty("message");
        expect(summary.rows.map((row) => row.id)).toEqual(["one"]);
    });

    it("merges checkout histories while preserving their cwd and newest-first order", () => {
        const root = aggregateAgentChatLoadState({
            detecting: false,
            cwd: "/repo",
            providers: [success(codex, [{ id: "root", title: "Root", mtime: 2 }])],
        });
        const lane = aggregateAgentChatLoadState({
            detecting: false,
            cwd: "/repo-lane",
            providers: [success(codex, [{ id: "lane", title: "Lane", mtime: 3 }])],
        });

        const merged = mergeAgentChatLoadSummaries([root, lane]);

        expect(merged.phase).toBe("ready");
        expect(merged.rows.map((row) => [row.id, row.cwd])).toEqual([
            ["lane", "/repo-lane"],
            ["root", "/repo"],
        ]);
    });
});

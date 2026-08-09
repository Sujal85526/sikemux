import { describe, expect, it } from "vitest";
import {
    AGENT_CONTEXT_LIMITS,
    normalizeAgentContext,
    prepareAgentContextDelivery,
    resolveAgentContextCwd,
    serializeAgentContext,
    type AgentContextFileReference,
    type AgentContextItem,
} from "./agentContext";

const location = { currentCwd: "/code/project" };

describe("agent context path and bound validation", () => {
    it("keeps workspace references relative and rejects lexical traversal unless explicitly external", () => {
        const result = normalizeAgentContext(
            [
                { kind: "file", path: "/code/project/src/main.ts" },
                { kind: "file", path: "src/../README.md" },
                { kind: "file", path: "../../secret.txt" },
                { kind: "image", path: "../../diagram.png", external: true, mimeType: "image/png" },
            ],
            location,
        );

        expect(result.items).toMatchObject([
            { kind: "file", path: "README.md" },
            { kind: "file", path: "src/main.ts" },
            { kind: "image", path: "/diagram.png", external: true },
        ]);
        expect(result.rejected).toEqual([{ index: 2, kind: "file", reason: "outside-agent-cwd" }]);
    });

    it("deduplicates canonical references and enforces kind and content bounds", () => {
        const files: AgentContextFileReference[] = Array.from({ length: AGENT_CONTEXT_LIMITS.files + 1 }, (_, index) => ({
            kind: "file",
            path: `src/${index}.ts`,
        }));
        const result = normalizeAgentContext(
            [
                files[0],
                { kind: "file", path: "src/./0.ts", label: "duplicate label" },
                ...files.slice(1),
                { kind: "diff", path: "x.ts", excerpt: "" },
            ],
            location,
        );

        expect(result.items.filter((item) => item.kind === "file")).toHaveLength(AGENT_CONTEXT_LIMITS.files);
        expect(result.rejected.map(({ reason }) => reason)).toEqual(["duplicate", "kind-limit", "empty-content"]);
    });

    it("rejects oversized images, text, ranges, and total item counts", () => {
        const reviews: AgentContextItem[] = Array.from({ length: AGENT_CONTEXT_LIMITS.items + 2 }, (_, index) => ({
            kind: "review",
            path: `src/${index}.ts`,
            side: "head",
            startLine: 1,
            comment: `review ${index}`,
        }));
        const result = normalizeAgentContext(
            [
                { kind: "image", path: "huge.png", bytes: AGENT_CONTEXT_LIMITS.imageBytes + 1 },
                { kind: "review", path: "wide.ts", side: "head", startLine: 1, endLine: AGENT_CONTEXT_LIMITS.reviewLineSpan + 1, comment: "wide" },
                { kind: "diff", path: "huge.ts", excerpt: "x".repeat(AGENT_CONTEXT_LIMITS.excerptLength + 1) },
                ...reviews,
            ],
            location,
        );

        expect(result.rejected.slice(0, 3).map(({ reason }) => reason)).toEqual(["invalid-image", "invalid-range", "field-too-long"]);
        expect(result.items).toHaveLength(AGENT_CONTEXT_LIMITS.reviews);
        expect(result.rejected.filter(({ reason }) => reason === "kind-limit")).toHaveLength(reviews.length - AGENT_CONTEXT_LIMITS.reviews);
    });

    it("enforces the combined item and serialized-text budgets", () => {
        const fullShelf: AgentContextItem[] = [
            ...Array.from({ length: AGENT_CONTEXT_LIMITS.files }, (_, index): AgentContextItem => ({ kind: "file", path: `f/${index}` })),
            ...Array.from({ length: AGENT_CONTEXT_LIMITS.images }, (_, index): AgentContextItem => ({ kind: "image", path: `i/${index}.png` })),
            ...Array.from({ length: AGENT_CONTEXT_LIMITS.diffs }, (_, index): AgentContextItem => ({
                kind: "diff",
                path: `d/${index}.ts`,
                excerpt: "x",
            })),
            ...Array.from({ length: 5 }, (_, index): AgentContextItem => ({
                kind: "review",
                path: `r/${index}.ts`,
                side: "head",
                startLine: 1,
                comment: "review",
            })),
        ];
        const itemBound = normalizeAgentContext(fullShelf, location);
        expect(itemBound.items).toHaveLength(AGENT_CONTEXT_LIMITS.items);
        expect(itemBound.rejected.at(-1)?.reason).toBe("item-limit");

        const textBound = normalizeAgentContext(
            Array.from({ length: AGENT_CONTEXT_LIMITS.diffs }, (_, index) => ({
                kind: "diff" as const,
                path: `large/${index}.ts`,
                excerpt: "x".repeat(AGENT_CONTEXT_LIMITS.excerptLength),
            })),
            location,
        );
        expect(textBound.rejected.some(({ reason }) => reason === "total-text-limit")).toBe(true);
    });
});

describe("agent context serialization", () => {
    it("sorts provider-neutral output deterministically", () => {
        const items: AgentContextItem[] = [
            { kind: "review", path: "z.ts", side: "head", startLine: 8, comment: "Review Z" },
            { kind: "image", path: "screen.png", mimeType: "image/png" },
            { kind: "file", path: "a.ts" },
            { kind: "diff", path: "b.ts", base: "main", head: "work", excerpt: "+new" },
            { kind: "review", path: "a.ts", side: "base", startLine: 2, comment: "Review A" },
        ];
        const forward = serializeAgentContext(items, location).text;
        const reverse = serializeAgentContext([...items].reverse(), location).text;

        expect(forward).toBe(reverse);
        expect(forward.indexOf("<file")).toBeLessThan(forward.indexOf("<image"));
        expect(forward.indexOf("<image")).toBeLessThan(forward.indexOf("<diff"));
        expect(forward.indexOf("<diff")).toBeLessThan(forward.indexOf("<review"));
        expect(forward).toContain('base="main" head="work"');
    });

    it("escapes XML delimiters and chooses fences longer than content collisions", () => {
        const result = serializeAgentContext(
            [
                {
                    kind: "review",
                    path: 'src/a&b".ts',
                    side: "head",
                    startLine: 4,
                    comment: "Do not close </review> & keep ````` literal",
                    excerpt: "<script>alert('x')</script>\n````diff",
                },
            ],
            location,
        );

        expect(result.text).toContain('path="src/a&amp;b&quot;.ts"');
        expect(result.text).toContain("Do not close &lt;/review&gt; &amp; keep ````` literal");
        expect(result.text).toContain("&lt;script&gt;alert(&apos;x&apos;)&lt;/script&gt;");
        expect(result.text).toContain("``````text\n");
        expect(result.text).not.toContain("Do not close </review>");
    });

    it("resolves worktree and current cwd lazily when delivery is prepared", () => {
        const state: { worktreePath?: string } = {};
        const lazy = () => ({ currentCwd: "/code/project", worktreePath: state.worktreePath });
        const item: AgentContextItem = { kind: "file", path: "src/main.ts" };

        expect(resolveAgentContextCwd(lazy)).toBe("/code/project");
        state.worktreePath = "/code/worktree";
        const prepared = prepareAgentContextDelivery([item], lazy, "insert-only");
        expect(prepared.cwd).toBe("/code/worktree");
        expect(prepared.items[0]).toMatchObject({ path: "src/main.ts" });
    });

    it("distinguishes insert-only from submit without mutating text or appending a newline", () => {
        const item: AgentContextItem = { kind: "file", path: "src/main.ts" };
        const insert = prepareAgentContextDelivery([item], location, "insert-only");
        const submit = prepareAgentContextDelivery([item], location, "submit");

        expect(insert.text).toBe(submit.text);
        expect(insert.text.endsWith("\n")).toBe(false);
        expect(insert).toMatchObject({ mode: "insert-only", submitAfterInsert: false });
        expect(submit).toMatchObject({ mode: "submit", submitAfterInsert: true });
        expect(insert).not.toHaveProperty("write");
        expect(insert).not.toHaveProperty("send");
    });
});

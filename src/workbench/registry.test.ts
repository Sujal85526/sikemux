import { describe, expect, it } from "vitest";
import type { PaneKind, PaneNode } from "../state/types/domain";
import {
    BUILTIN_WORKBENCH_ITEM_MANIFEST,
    DuplicateWorkbenchItemKindError,
    UnknownWorkbenchItemKindError,
    WorkbenchItemRegistry,
    createItemId,
    createWorkbenchItemRef,
    workbenchItemRefFromPane,
    type PersistedCodecResult,
    type WorkbenchItemController,
    type WorkbenchItemDefinition,
} from "./registry";

const BUILTIN_KINDS = ["terminal", "editor", "git", "aws", "search", "rundeck", "bruno"] as const satisfies readonly PaneKind[];

function nullEnvelope(itemId: string, kind: PaneKind, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { itemId, kind, version: 1, state: null, ...overrides };
}

describe("built-in workbench item manifest", () => {
    it("is exhaustive for current PaneKind values and creates safe no-op controllers", async () => {
        expect(Object.keys(BUILTIN_WORKBENCH_ITEM_MANIFEST)).toEqual(BUILTIN_KINDS);
        const registry = new WorkbenchItemRegistry();

        for (const kind of BUILTIN_KINDS) {
            const definition = BUILTIN_WORKBENCH_ITEM_MANIFEST[kind];
            expect(definition.kind).toBe(kind);
            expect(definition.defaultTitle).not.toBe("");
            expect(definition.persisted.version).toBe(1);

            const controller = registry.create(createWorkbenchItemRef(`pane-${kind}`, kind));
            await controller.activate();
            await controller.deactivate();
            expect(await controller.canClose()).toBe(true);
            await controller.dispose();
        }
        expect(registry.kinds()).toEqual(BUILTIN_KINDS);
    });

    it("derives a typed item reference from the existing PaneNode", () => {
        const pane: PaneNode = { type: "pane", id: "pane-editor", cwd: "/project", kind: "editor", title: "Editor" };
        const ref = workbenchItemRefFromPane(pane);

        expect(ref).toEqual({ id: "pane-editor", kind: "editor" });
        expect(createItemId("pane-1")).toBe("pane-1");
        expect(() => createItemId(" pane-1 ")).toThrow(TypeError);
        expect(() => createItemId("pane\n1")).toThrow(TypeError);
    });
});

describe("WorkbenchItemRegistry lifecycle", () => {
    it("runs custom controller lifecycle and cleanup hooks", async () => {
        const events: string[] = [];
        const controller: WorkbenchItemController = {
            activate: () => {
                events.push("activate");
            },
            deactivate: async () => {
                events.push("deactivate");
            },
            canClose: () => {
                events.push("can-close");
                return false;
            },
            dispose: () => {
                events.push("dispose");
            },
        };
        const definition: WorkbenchItemDefinition<"notes", string> = {
            kind: "notes",
            defaultTitle: "Notes",
            create: (ref) => {
                events.push(`create:${ref.id}`);
                return controller;
            },
            persisted: {
                version: 3,
                encode: (state) => state,
                decode: (encoded): PersistedCodecResult<string> => (typeof encoded === "string" ? { ok: true, value: encoded } : { ok: false }),
            },
            cleanupDraft: async (state) => {
                events.push(`cleanup:${state}`);
            },
        };
        const registry = new WorkbenchItemRegistry();
        registry.register(definition);
        const ref = createWorkbenchItemRef("item-notes", "notes");
        const created = registry.create(ref);

        await created.activate();
        await created.deactivate();
        expect(await created.canClose()).toBe(false);
        await registry.cleanupDraft(ref, "draft");
        await created.dispose();

        expect(events).toEqual(["create:item-notes", "activate", "deactivate", "can-close", "cleanup:draft", "dispose"]);
    });

    it("rejects duplicate and unknown registrations", () => {
        const registry = new WorkbenchItemRegistry();
        expect(() => registry.register(BUILTIN_WORKBENCH_ITEM_MANIFEST.editor)).toThrow(DuplicateWorkbenchItemKindError);
        expect(() => registry.get("missing")).toThrow(UnknownWorkbenchItemKindError);
        expect(() => registry.create(createWorkbenchItemRef("item-missing", "missing"))).toThrow(UnknownWorkbenchItemKindError);
    });
});

describe("workbench item persistence", () => {
    it("round-trips isolated editor state with exact ID, kind, and version matching", () => {
        const registry = new WorkbenchItemRegistry();
        const ref = createWorkbenchItemRef("pane-editor", "editor");
        const openTabs = ["/project/a.ts", "/project/b.ts"];
        const encoded = registry.encodePersisted(ref, {
            openTabs,
            activePath: "/project/b.ts",
            treeWidth: 240,
        });
        openTabs.push("/project/not-persisted.ts");

        expect(encoded).toEqual({
            itemId: "pane-editor",
            kind: "editor",
            version: 1,
            state: {
                openTabs: ["/project/a.ts", "/project/b.ts"],
                activePath: "/project/b.ts",
                treeWidth: 240,
            },
        });
        const decoded = registry.decodePersisted(ref, encoded);
        expect(decoded).toEqual({
            ok: true,
            ref,
            state: {
                openTabs: ["/project/a.ts", "/project/b.ts"],
                activePath: "/project/b.ts",
                treeWidth: 240,
            },
        });
        if (decoded.ok) expect(decoded.state).not.toBe(encoded.state);
    });

    it("round-trips null state for every non-editor built-in kind", () => {
        const registry = new WorkbenchItemRegistry();
        for (const kind of BUILTIN_KINDS.filter((candidate) => candidate !== "editor")) {
            const ref = createWorkbenchItemRef(`pane-${kind}`, kind);
            const encoded = registry.encodePersisted(ref, null);
            expect(registry.decodePersisted(ref, encoded)).toEqual({ ok: true, ref, state: null });
        }
    });

    it.each([
        ["non-object", null, "invalid-envelope"],
        ["missing state", { itemId: "pane-terminal", kind: "terminal", version: 1 }, "invalid-envelope"],
        ["extra field", { ...nullEnvelope("pane-terminal", "terminal"), payload: "nope" }, "invalid-envelope"],
        ["accessor", Object.defineProperty({}, "itemId", { enumerable: true, get: () => "pane-terminal" }), "invalid-envelope"],
        ["invalid item ID", nullEnvelope(" bad ", "terminal"), "invalid-envelope"],
        ["different item ID", nullEnvelope("pane-other", "terminal"), "item-id-mismatch"],
        ["different kind", nullEnvelope("pane-terminal", "git"), "kind-mismatch"],
        ["unknown kind", nullEnvelope("pane-terminal", "terminal", { kind: "notes" }), "unknown-kind"],
        ["different version", nullEnvelope("pane-terminal", "terminal", { version: 2 }), "version-mismatch"],
        ["non-integer version", nullEnvelope("pane-terminal", "terminal", { version: 1.5 }), "invalid-envelope"],
        ["invalid null state", nullEnvelope("pane-terminal", "terminal", { state: {} }), "invalid-state"],
    ])("rejects malformed envelope: %s", (_label, encoded, reason) => {
        const registry = new WorkbenchItemRegistry();
        const ref = createWorkbenchItemRef("pane-terminal", "terminal");
        expect(registry.decodePersisted(ref, encoded)).toEqual({ ok: false, reason });
    });

    it("rejects malformed editor view state", () => {
        const registry = new WorkbenchItemRegistry();
        const ref = createWorkbenchItemRef("pane-editor", "editor");
        const malformed = {
            itemId: "pane-editor",
            kind: "editor",
            version: 1,
            state: { openTabs: ["/ok", 7], activePath: "/ok", treeWidth: Number.NaN },
        };

        expect(registry.decodePersisted(ref, malformed)).toEqual({ ok: false, reason: "invalid-state" });
    });

    it("does not let runtime registration widen persisted built-in kinds", () => {
        const registry = new WorkbenchItemRegistry();
        registry.register({
            kind: "notes",
            defaultTitle: "Notes",
            create: () => ({ activate() {}, deactivate() {}, canClose: () => true, dispose() {} }),
            persisted: {
                version: 1,
                encode: (state: string) => state,
                decode: (encoded: unknown): PersistedCodecResult<string> =>
                    typeof encoded === "string" ? { ok: true, value: encoded } : { ok: false },
            },
        });
        const runtimeRef = createWorkbenchItemRef("item-notes", "notes");
        expect(registry.create(runtimeRef).canClose()).toBe(true);

        const forgedBuiltinRef = runtimeRef as unknown as ReturnType<typeof createWorkbenchItemRef<PaneKind>>;
        const encoded = { itemId: "item-notes", kind: "notes", version: 1, state: "private draft" };
        expect(registry.decodePersisted(forgedBuiltinRef, encoded)).toEqual({ ok: false, reason: "unknown-kind" });
        expect(() => registry.encodePersisted(forgedBuiltinRef, null)).toThrow(UnknownWorkbenchItemKindError);
    });
});

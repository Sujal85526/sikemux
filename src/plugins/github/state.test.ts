import { describe, expect, it } from "vitest";
import {
    actionsSettings,
    closeRun,
    compose,
    filterBy,
    refOf,
    setProjectRepo,
    showRepo,
    showRun,
    showSection,
    slugOf,
    togglePinned,
    updateView,
    viewOf,
    type ActionsSettings,
} from "./state";

describe("actionsSettings", () => {
    it("falls back to usable settings whatever was saved", () => {
        actionsSettings.update(
            () =>
                ({
                    pinned: ["nodelike/sikemux", "not a repo", 7, "nodelike/sikemux"],
                    repoByProject: { "/repo": "owner/name", "/bad": 3, "/alsobad": "owner" },
                    lastRepo: 12,
                }) as unknown as ActionsSettings,
        );
        expect(actionsSettings.get()).toEqual({
            pinned: ["nodelike/sikemux"],
            repoByProject: { "/repo": "owner/name" },
            lastRepo: null,
            followBranch: true,
        });
    });

    it("keeps following the branch unless it was turned off on purpose", () => {
        actionsSettings.update(() => ({ followBranch: false }) as unknown as ActionsSettings);
        expect(actionsSettings.get().followBranch).toBe(false);
        actionsSettings.update(() => ({}) as unknown as ActionsSettings);
        expect(actionsSettings.get().followBranch).toBe(true);
    });

    it("pins and unpins the same repository with one call", () => {
        actionsSettings.update(() => ({}) as unknown as ActionsSettings);
        togglePinned("a/b");
        expect(actionsSettings.get().pinned).toEqual(["a/b"]);
        togglePinned("a/b");
        expect(actionsSettings.get().pinned).toEqual([]);
    });

    it("forgets a project's repository when it is cleared", () => {
        actionsSettings.update(() => ({}) as unknown as ActionsSettings);
        setProjectRepo("/work", "a/b");
        expect(actionsSettings.get().repoByProject).toEqual({ "/work": "a/b" });
        setProjectRepo("/work", null);
        expect(actionsSettings.get().repoByProject).toEqual({});
    });
});

describe("refOf", () => {
    it("reads owner and repo out of a slug", () => {
        expect(refOf("nodelike/sikemux")).toEqual({ owner: "nodelike", name: "sikemux" });
    });

    it("refuses anything that is not exactly one slug", () => {
        for (const bad of ["", "nodelike", "a/b/c", "/b", "a/"]) {
            expect(refOf(bad)).toBeNull();
        }
    });

    it("round-trips through slugOf", () => {
        expect(slugOf({ owner: "a", name: "b" })).toBe("a/b");
        expect(refOf(slugOf({ owner: "a", name: "b" }))).toEqual({ owner: "a", name: "b" });
    });
});

describe("the view of one pane", () => {
    it("starts fresh, and remembers what it is shown", () => {
        expect(viewOf("pane-new").repo).toBeNull();
        showRepo("pane-1", { owner: "a", name: "b" });
        expect(viewOf("pane-1").repo).toEqual({ owner: "a", name: "b" });
        expect(actionsSettings.get().lastRepo).toBe("a/b");
    });

    it("clears the open run and goes back to the first page when a filter changes", () => {
        showRepo("pane-2", { owner: "a", name: "b" });
        updateView("pane-2", { page: 4 });
        showRun("pane-2", 99);
        expect(viewOf("pane-2").run).toBe(99);

        filterBy("pane-2", { statusFilter: "failure" });
        expect(viewOf("pane-2")).toMatchObject({ statusFilter: "failure", page: 1, run: null, job: null });
    });

    it("keeps the repository when the open run is closed", () => {
        showRepo("pane-3", { owner: "a", name: "b" });
        showRun("pane-3", 7);
        updateView("pane-3", { job: 3 });
        closeRun("pane-3");
        expect(viewOf("pane-3")).toMatchObject({ repo: { owner: "a", name: "b" }, run: null, job: null });
    });

    it("starts over when a different repository is shown in the same pane", () => {
        showRepo("pane-4", { owner: "a", name: "b" });
        updateView("pane-4", { statusFilter: "failure", page: 3, workflowId: 12 });
        showRepo("pane-4", { owner: "c", name: "d" });
        expect(viewOf("pane-4")).toMatchObject({ repo: { owner: "c", name: "d" }, statusFilter: "all", page: 1, workflowId: null });
    });

    it("stays in the section it was on when the repository changes", () => {
        showRepo("pane-5", { owner: "a", name: "b" });
        showSection("pane-5", "issues");
        showRepo("pane-5", { owner: "c", name: "d" });
        expect(viewOf("pane-5")).toMatchObject({ section: "issues", repo: { owner: "c", name: "d" } });
    });

    it("keeps a half-written pull request when the repository on screen is the same one", () => {
        showSection("pane-6", "pulls");
        compose("pane-6", "pull");
        showRepo("pane-6", { owner: "a", name: "b" }, { owner: "a", name: "b" });
        expect(viewOf("pane-6")).toMatchObject({ section: "pulls", composing: "pull", repo: { owner: "a", name: "b" } });
    });
});

import { describe, expect, it } from "vitest";
import type { RepoListing, Workflow } from "../api";
import { actionsSettings, showSection, updateView, viewOf } from "../state";
import { paletteItems } from "./ActionsPalette";

const repo = (slug: string): RepoListing => {
    const [owner = "", name = ""] = slug.split("/");
    return { owner, name, slug, private: false, archived: false, defaultBranch: "main", pushedAt: null, url: "" };
};

const workflow = (id: number, name: string): Workflow => ({
    id,
    name,
    path: `.github/workflows/${name}.yml`,
    state: "active",
    active: true,
    url: "",
});

const REPOS = [repo("nodelike/sikemux"), repo("acme/website")];
const WORKFLOWS = [workflow(1, "CI"), workflow(2, "Release")];

const PLACE = { cwd: null, shown: null };

const ids = (query: string) => paletteItems(query, REPOS, WORKFLOWS, PLACE).map((item) => item.id);

describe("paletteItems", () => {
    it("offers filters and everything open before anything is typed", () => {
        const items = ids("");
        expect(items).toContain("filter:all");
        expect(items).toContain("workflow:1");
        expect(items).toContain("repo:acme/website");
        expect(items).toContain("back");
    });

    it("narrows to what was typed", () => {
        expect(ids("Release")).toEqual(["workflow:2"]);
        expect(ids("website")).toEqual(["repo:acme/website"]);
    });

    it("offers a repository nobody listed, as long as it is shaped like one", () => {
        expect(ids("someone/private-thing")[0]).toBe("open:someone/private-thing");
    });

    it("does not offer to open a repository it already lists", () => {
        expect(ids("nodelike/sikemux")).toEqual(["repo:nodelike/sikemux"]);
    });

    it("finds nothing rather than guessing", () => {
        expect(ids("zzzzz-nothing-here")).toEqual([]);
    });

    it("runs the pane action the chosen item stands for", () => {
        const found = paletteItems("Release", REPOS, WORKFLOWS, PLACE)[0];
        expect(found?.hint).toBe("workflow");
        expect(typeof found?.run).toBe("function");
    });

    it("goes to Actions when a filter or a workflow is picked from another section", () => {
        showSection("palette-pane", "pulls");
        updateView("palette-pane", { item: 4 });
        paletteItems("Failed", REPOS, WORKFLOWS, PLACE)[0]?.run("palette-pane");
        expect(viewOf("palette-pane")).toMatchObject({ section: "actions", item: null, statusFilter: "failure" });

        showSection("palette-pane", "issues");
        paletteItems("Release", REPOS, WORKFLOWS, PLACE)[0]?.run("palette-pane");
        expect(viewOf("palette-pane")).toMatchObject({ section: "actions", workflowId: 2 });
    });

    it("remembers a repository opened from it for the project in front", () => {
        const place = { cwd: "/work/site", shown: null };
        paletteItems("someone/private-thing", REPOS, WORKFLOWS, place)[0]?.run("palette-pane-2");
        expect(actionsSettings.get().repoByProject["/work/site"]).toBe("someone/private-thing");
        paletteItems("website", REPOS, WORKFLOWS, place)[0]?.run("palette-pane-2");
        expect(actionsSettings.get().repoByProject["/work/site"]).toBe("acme/website");
    });
});

import { describe, expect, it } from "vitest";
import type { ProviderProfile, Session } from "../state/types";
import { remoteWorkspace } from "./workspace";

function project(id: string, cwd: string): Session {
    return { id, name: cwd.split("/").at(-1) ?? id, kind: "project", cwd, pinned: false, activeWindowId: `${id}-window` };
}

const sessions: Record<string, Session> = {
    a: project("a", "/Users/me/sikemux"),
    ssh: { ...project("ssh", ""), kind: "ssh", name: "gpu-box" },
    b: project("b", "/Users/me/site"),
};

function profile(id: string, name: string, provider: ProviderProfile["provider"]): ProviderProfile {
    return { id, name, provider, accent: "#fff", configPath: `~/.${id}`, environmentKeys: ["ANTHROPIC_API_KEY"] };
}

describe("remoteWorkspace", () => {
    it("offers the open local projects in tab order and never an SSH host", () => {
        const { projects } = remoteWorkspace(sessions, ["b", "ssh", "a"], [], "bypass");
        expect(projects).toEqual([
            { id: "b", name: "site", path: "/Users/me/site" },
            { id: "a", name: "sikemux", path: "/Users/me/sikemux" },
        ]);
    });

    it("offers each chat agent once, or once per profile, with the default permission mode it supports", () => {
        const profiles = [profile("work", "Work", "claude"), profile("home", "Home", "claude"), profile("cx", "Default", "codex")];
        const { launchers } = remoteWorkspace(sessions, [], profiles, "bypass");
        const byId = Object.fromEntries(launchers.map((launcher) => [launcher.id, launcher]));
        expect(Object.keys(byId).sort()).toEqual(["claude:home", "claude:work", "codex:cx", "grok", "hermes", "omp", "opencode"]);
        expect(byId["claude:work"]).toMatchObject({
            provider: "claude",
            label: "Claude · Work",
            configPath: "~/.work",
            environmentKeys: ["ANTHROPIC_API_KEY"],
        });
        expect(byId["codex:cx"].label).toBe("Codex");
        expect(byId["opencode"].permissionMode).toBe("workspace-write");
        expect(byId["grok"].permissionMode).toBe("bypass");
    });
});

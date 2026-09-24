import { describe, expect, it } from "vitest";
import type { PluginManifest } from "../api/plugins";
import { railGroupOf } from "./railGroups";

const rundeck: PluginManifest = { id: "sikemux.rundeck", name: "Rundeck", version: "0.1.0", sikemux: ">=0.4", group: "ci-cd" };

describe("railGroupOf", () => {
    it("puts a plugin's sessions in the group its manifest names", () => {
        expect(railGroupOf("sikemux.rundeck:deploy", [rundeck])).toBe("ci-cd");
    });

    it("leaves out sessions of a plugin this build does not have", () => {
        expect(railGroupOf("sikemux.rundeck:deploy", [])).toBeNull();
    });

    it("keeps core sessions where they were", () => {
        expect(railGroupOf("project", [])).toBe("project");
        expect(railGroupOf("aws", [])).toBe("cloud");
        expect(railGroupOf("bruno", [])).toBe("apis");
    });
});

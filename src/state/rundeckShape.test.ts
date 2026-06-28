import { describe, expect, it } from "vitest";
import { envFolderOf, inferEnv } from "./rundeckShape";

describe("Rundeck shape helpers", () => {
    it("extracts env folder from grouped jobs", () => {
        expect(envFolderOf("prod/service-a")).toBe("prod");
        expect(envFolderOf("service-a")).toBeNull();
        expect(envFolderOf(null)).toBeNull();
        expect(inferEnv("Deployments", "staging/api")).toBe("staging");
        expect(inferEnv("Deployments", null)).toBe("deployments");
    });
});

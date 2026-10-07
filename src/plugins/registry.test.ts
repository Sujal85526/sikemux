import { describe, expect, it } from "vitest";
import { isPluginKind, pluginIdOf } from "./kinds";
import { frontendPlugin, linkPlugin, registerFrontendPlugin } from "./registry";

const surface = (kind: `${string}.${string}:${string}`) => ({ kind, title: "Example", icon: () => null, render: () => null });

describe("plugin kinds", () => {
    it("names a plugin's surface after the plugin", () => {
        expect(isPluginKind("sikemux.rundeck:deploy")).toBe(true);
        expect(pluginIdOf("sikemux.rundeck:deploy")).toBe("sikemux.rundeck");
        for (const kind of ["rundeck", "terminal", "sikemux.rundeck", "sikemux.rundeck/deploy", "Sikemux.rundeck:deploy", ""]) {
            expect(isPluginKind(kind)).toBe(false);
        }
    });
});

describe("frontend plugin registry", () => {
    it("refuses a surface named after another plugin", () => {
        expect(() =>
            registerFrontendPlugin({ id: "test.thief", surfaces: [surface("test.other:view")], open: () => {}, openTitle: "Open" }),
        ).toThrow();
        expect(frontendPlugin("test.thief")).toBeUndefined();
    });

    it("finds the plugin a link points at by its host", () => {
        registerFrontendPlugin({ id: "test.links", surfaces: [], open: () => {}, openTitle: "Open", linkHosts: [".example.net", "example.org"] });
        for (const href of ["https://acme.example.net/browse/CIQ-1", "https://Example.org/a/b", "http://user@example.org:8080/x"]) {
            expect(linkPlugin(href)?.id).toBe("test.links");
        }
        for (const href of ["https://notexample.org/", "https://example.net.evil.com/", "src/App.tsx", "mailto:a@example.org"]) {
            expect(linkPlugin(href)).toBeUndefined();
        }
    });
});

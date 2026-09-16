import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(process.cwd(), "src");

function stylesheets(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return entry.name === "node_modules" ? [] : stylesheets(path);
        return entry.isFile() && entry.name.endsWith(".css") ? [path] : [];
    });
}

describe("tab layer visibility", () => {
    // Only a painted `.window-layer` is on screen; the rest are hidden with
    // `visibility: hidden`. A descendant that declares `visibility: visible` undoes
    // that for its own subtree, so the hidden tab paints over the live one.
    it("no stylesheet re-enables visibility inside a hidden layer", () => {
        const offenders = stylesheets(ROOT).flatMap((path) =>
            readFileSync(path, "utf8")
                .split("\n")
                .flatMap((line, index) => (/^\s*visibility:\s*visible\s*(!important)?\s*;/.test(line) ? [`${path}:${index + 1}`] : [])),
        );
        expect(offenders, "hide with `:not(.painted) { visibility: hidden }` instead").toEqual([]);
    });

    // A session's track covers the stage whether or not that session is the one
    // on screen, and an empty box with no background still takes a click. The
    // last track in the document swallowed every click meant for the pane under
    // it, which read as a dead screen that blurred whatever the reader was in.
    it("leaves the click to the screen being read rather than to a track over it", () => {
        const chrome = readFileSync(join(ROOT, "styles", "chrome.css"), "utf8");
        const track = /\.window-track\s*\{[^}]*\}/g;
        const blocks = chrome.match(track) ?? [];
        expect(
            blocks.some((block) => /pointer-events:\s*none/.test(block)),
            ".window-track must not take clicks",
        ).toBe(true);
        expect(/\.window-layer\.live\s*\{[^}]*pointer-events:\s*auto/.test(chrome), "the live screen takes them instead").toBe(true);
    });
});

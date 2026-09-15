import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { VERSION } from "./persist";

const STATE_RS = join(process.cwd(), "src-tauri", "src", "state.rs");

describe("application state version", () => {
    // The backend refuses to save a snapshot whose version is not its own, and
    // the two numbers live in different languages with nothing joining them.
    it("matches APPLICATION_STATE_VERSION in the Rust backend", () => {
        const matched = readFileSync(STATE_RS, "utf8").match(/const APPLICATION_STATE_VERSION: i64 = (\d+);/);
        expect(matched, `no APPLICATION_STATE_VERSION found in ${STATE_RS}`).not.toBeNull();
        expect(
            Number(matched?.[1]),
            "bump VERSION in src/state/persist.ts and APPLICATION_STATE_VERSION in src-tauri/src/state.rs together, in the same commit, or every save fails",
        ).toBe(VERSION);
    });
});

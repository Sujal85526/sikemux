import { bench, describe } from "vitest";
import { parseDiffFromFile, type FileContents } from "@pierre/diffs";
import { UiActivityTracker } from "./lib/activity";
import { PerformanceTelemetry } from "./lib/performance";
import { rankBy } from "./lib/fuzzy";
import { computeLayout, splitPane } from "./state/layout";
import { tokenizeCode } from "./chat/shikiTokens";
import { codeThemeName } from "./themes/codeTheme";
import { DEFAULT_THEME_ID, themeById } from "./themes";
import type { LayoutNode, PaneNode } from "./state/types";

const candidates = Array.from({ length: 5_000 }, (_, index) => `src/project-${index}/component-${index % 97}.tsx`);
const pane = (id: string): PaneNode => ({ type: "pane", id, cwd: "/repo", kind: "terminal", title: id });
let layout: LayoutNode = pane("pane-0");
for (let index = 1; index < 24; index += 1) {
    layout = splitPane(layout, `pane-${index - 1}`, index % 2 === 0 ? "row" : "column", pane(`pane-${index}`));
}

function pierreInputs(fileCount: number, lineCount: number, changeEvery: number): Array<readonly [FileContents, FileContents]> {
    return Array.from({ length: fileCount }, (_, fileIndex) => {
        const base: string[] = [];
        const head: string[] = [];
        for (let lineIndex = 0; lineIndex < lineCount; lineIndex += 1) {
            const line = `export const value_${fileIndex}_${lineIndex} = ${lineIndex};`;
            base.push(line);
            head.push(lineIndex % changeEvery === 0 ? `export const value_${fileIndex}_${lineIndex} = ${lineIndex + 1};` : line);
        }
        const name = `src/file-${fileIndex}.ts`;
        return [
            { name, contents: base.join("\n"), lang: "typescript", cacheKey: `base-${fileIndex}` },
            { name, contents: head.join("\n"), lang: "typescript", cacheKey: `head-${fileIndex}` },
        ] as const;
    });
}

const activityTracker = new UiActivityTracker();
for (let index = 0; index < 24; index += 1) activityTracker.beginCommand(`inflight_${index}`);

const manyPierreDiffs = pierreInputs(1_000, 250, 25);
const tallPierreDiffs = pierreInputs(25, 2_000, 100);

for (const count of [5_000, 50_000, 250_000]) {
    const files = Array.from({ length: count }, (_, index) => `src/project-${index % 97}/component-${index}.tsx`);
    describe(`file palette with ${count.toLocaleString("en-US")} files`, () => {
        bench("rank all matches then slice 200", () => {
            rankBy("component", files, (path) => path).slice(0, 200);
        });
        bench("retain only the best 200 matches", () => {
            rankBy("component", files, (path) => path, 200);
        });
    });
}

describe("interactive hot paths", () => {
    bench("rank 5,000 file-palette candidates", () => {
        rankBy("component 42", candidates, (value) => value);
    });

    bench("compute a 24-pane layout", () => {
        computeLayout(layout);
    });

    bench("record 100 bounded telemetry samples", () => {
        const telemetry = new PerformanceTelemetry({ spanCapacity: 64, latencySampleCapacity: 64 });
        for (let index = 0; index < 100; index += 1) {
            const span = telemetry.startTrace("bench", { index });
            const recorded = telemetry.endSpan(span);
            if (recorded) telemetry.recordLatency("bench", recorded.durationMs);
        }
        telemetry.snapshot();
    });

    bench("record 1,000 IPC calls in the activity tracker", () => {
        for (let index = 0; index < 1_000; index += 1) {
            activityTracker.endCommand(activityTracker.beginCommand("pty_write"), true);
        }
    });

    bench("build one activity report", () => {
        activityTracker.snapshot();
    });

    bench("parse 1,000 Pierre diffs with 10 changes each", () => {
        for (const [base, head] of manyPierreDiffs) parseDiffFromFile(base, head);
    });

    bench("parse 25 Pierre diffs with 2,000 lines each", () => {
        for (const [base, head] of tallPierreDiffs) parseDiffFromFile(base, head);
    });
});

/* What a chat fence costs to colour. The transcript asks for one fence at a
   time, once each, after it has stopped changing. */
const chatTheme = themeById(DEFAULT_THEME_ID);
const chatThemeName = codeThemeName(chatTheme);
const fence = (lines: number) => Array.from({ length: lines }, (_, line) => `export const value_${line} = fn(${line}); // note`).join("\n");
const shortFence = fence(20);
const longestFence = fence(150);

// Loaded once here so the runs below measure the reading rather than the
// grammar arriving, which a pane pays for at most once a session.
await tokenizeCode("const ready = true;", "typescript", chatTheme, chatThemeName);

describe("chat code fences", () => {
    bench("colour a 20-line typescript fence", async () => {
        await tokenizeCode(shortFence, "typescript", chatTheme, chatThemeName);
    });

    bench("colour the longest fence a chat will colour", async () => {
        await tokenizeCode(longestFence, "typescript", chatTheme, chatThemeName);
    });
});

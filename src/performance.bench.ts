import { bench, describe } from "vitest";
import { PerformanceTelemetry } from "./lib/performance";
import { rankBy } from "./lib/fuzzy";
import { computeLayout, splitPane } from "./state/layout";
import type { LayoutNode, PaneNode } from "./state/types";

const candidates = Array.from({ length: 5_000 }, (_, index) => `src/project-${index}/component-${index % 97}.tsx`);
const pane = (id: string): PaneNode => ({ type: "pane", id, cwd: "/repo", kind: "terminal", title: id });
let layout: LayoutNode = pane("pane-0");
for (let index = 1; index < 24; index += 1) {
    layout = splitPane(layout, `pane-${index - 1}`, index % 2 === 0 ? "row" : "column", pane(`pane-${index}`));
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
});

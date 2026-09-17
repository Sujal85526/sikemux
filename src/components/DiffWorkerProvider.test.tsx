import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const { contextProvider } = vi.hoisted(() => ({ contextProvider: vi.fn() }));
vi.mock("@pierre/diffs/react", () => ({
    WorkerPoolContextProvider: (props: { highlighterOptions?: { theme?: string }; children?: unknown }) => {
        contextProvider(props);
        return props.children;
    },
}));
vi.mock("./DiffEditor", () => ({ DIFF_WORD_MAX_LENGTH: 512 }));

const { DiffWorkerProvider } = await import("./DiffWorkerProvider");

vi.stubGlobal("Worker", class {});

afterEach(cleanup);

it("names the theme the pool should render with", () => {
    render(
        <DiffWorkerProvider>
            <span>diff</span>
        </DiffWorkerProvider>,
    );

    const options = contextProvider.mock.calls.at(-1)?.[0]?.highlighterOptions;
    // Left unset the pool falls back to a bundled theme this app does not ship,
    // and every render rejects instead of drawing.
    expect(options?.theme).toBeTruthy();
    expect(options?.theme).toMatch(/^sikemux-/);
});

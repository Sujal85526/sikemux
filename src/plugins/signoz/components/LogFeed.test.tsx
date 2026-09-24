import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { tailStart, tailStop } = vi.hoisted(() => ({ tailStart: vi.fn(), tailStop: vi.fn(() => Promise.resolve()) }));
vi.mock("../api", async (importOriginal) => ({ ...(await importOriginal<object>()), signozApi: { tailStart, tailStop } }));

import { LogFeed } from "./LogFeed";

describe("LogFeed", () => {
    it("stops a tail whose id arrives after the pane has gone", async () => {
        let resolveId!: (id: number) => void;
        tailStart.mockReturnValue(new Promise<number>((resolve) => (resolveId = resolve)));
        const { unmount } = render(<LogFeed paneId="pane-late" active />);
        unmount();
        await act(async () => resolveId(9));
        expect(tailStop).toHaveBeenCalledWith(9);
    });

    it("asks for errors only until told otherwise", () => {
        tailStart.mockReset().mockReturnValue(new Promise<number>(() => {}));
        render(<LogFeed paneId="pane-errors" active />);
        expect(tailStart.mock.calls[0][0]).toMatchObject({ severities: ["ERROR", "FATAL"], minutes: 15 });
    });
});

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { VirtualPanelRows } from "./VirtualPanelRows";

describe("VirtualPanelRows", () => {
    it("renders small lists without a virtual scroll wrapper", () => {
        render(
            <div>
                <VirtualPanelRows items={["one", "two"]} selectedIndex={0} focused getKey={(item) => item} renderRow={(item) => <div>{item}</div>} />
            </div>,
        );
        expect(screen.getByText("one")).toBeInTheDocument();
        expect(screen.getByText("two")).toBeInTheDocument();
        expect(document.querySelector(".git-virtual-rows")).toBeNull();
    });
});

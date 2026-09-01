import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AgentIcon } from "./Icons";

describe("AgentIcon", () => {
    it("keeps the OpenCode mark inside the shared optical box", () => {
        const { container } = render(<AgentIcon type="opencode" size={20} />);
        const svg = container.querySelector("svg");

        expect(svg).toHaveAttribute("viewBox", "-50 -50 400 400");
        expect(svg).toHaveAttribute("width", "20");
        expect(svg).toHaveAttribute("height", "20");
    });
});

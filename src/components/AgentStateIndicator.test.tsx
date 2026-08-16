import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentPresentationState } from "../state/types";
import { AgentStateIndicator } from "./AgentStateIndicator";

afterEach(cleanup);

describe("AgentStateIndicator", () => {
    it("renders working as a dedicated circular CSS loader", () => {
        const { container } = render(<AgentStateIndicator state="working" />);
        expect(screen.getByRole("img", { name: "Working" })).toBeInTheDocument();
        expect(container.querySelector(".agent-state-loader")).toBeInTheDocument();
        expect(container.querySelector("svg")).not.toBeInTheDocument();
    });

    it.each(["blocked", "done", "idle", "stopped", "unknown"] as const)("renders nothing for %s", (state) => {
        const { container } = render(<AgentStateIndicator state={state as AgentPresentationState} />);
        expect(container).toBeEmptyDOMElement();
    });
});

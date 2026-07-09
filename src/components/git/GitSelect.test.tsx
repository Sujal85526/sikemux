import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { GitSelect } from "./GitSelect";

describe("GitSelect", () => {
    it("opens options and reports selected value", async () => {
        const user = userEvent.setup();
        const onSelect = vi.fn();
        render(
            <GitSelect
                value="hermes"
                label="Hermes"
                options={[
                    { value: "hermes", label: "Hermes" },
                    { value: "codex", label: "Codex" },
                ]}
                onSelect={onSelect}
            />,
        );

        await user.click(screen.getByRole("button", { name: /hermes/i }));
        expect(screen.getByRole("option", { name: /codex/i })).toBeInTheDocument();
        await user.click(screen.getByRole("option", { name: /codex/i }));
        expect(onSelect).toHaveBeenCalledWith("codex");
        expect(screen.queryByRole("button", { name: /codex/i })).not.toBeInTheDocument();
    });
});

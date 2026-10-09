import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseProfile } from "../api";
import { consoleTab, historyTab, tableTab } from "../tabs";
import { TabStrip } from "./TabStrip";

const profiles: DatabaseProfile[] = [
    { id: "p1", name: "Shop", readOnly: false, agentWrites: false, hasPassword: false, engine: "sqlite", path: "/shop.db" },
    { id: "p2", name: "Analytics", readOnly: false, agentWrites: false, hasPassword: false, engine: "sqlite", path: "/a.db" },
];
const tabs = [consoleTab("p1", 1), tableTab("p2", "main", "events"), historyTab("p1")];

afterEach(cleanup);

function renderStrip(active = "console:p1:1") {
    const props = { onSelect: vi.fn(), onClose: vi.fn(), onCloseOthers: vi.fn(), onNewConsole: vi.fn() };
    render(<TabStrip tabs={tabs} active={active} profiles={profiles} {...props} />);
    return props;
}

describe("TabStrip", () => {
    it("names each tab with its connection, and marks the one in front", () => {
        renderStrip();
        expect(screen.getByRole("tab", { name: "Shop console" })).toHaveAttribute("aria-selected", "true");
        expect(screen.getByRole("tab", { name: "Analytics events" })).toHaveAttribute("title", "Analytics · main.events");
        expect(screen.getByRole("tab", { name: "Shop history" })).toHaveAttribute("aria-selected", "false");
    });

    it("selects, closes with its button or the middle button, and closes the others", () => {
        const props = renderStrip();
        fireEvent.click(screen.getByRole("tab", { name: "Analytics events" }));
        expect(props.onSelect).toHaveBeenCalledWith("table:p2:main.events");
        fireEvent.click(screen.getByRole("button", { name: "Close Shop history" }));
        expect(props.onClose).toHaveBeenCalledWith("history:p1");
        fireEvent.mouseDown(screen.getByRole("tab", { name: "Shop console" }), { button: 1 });
        expect(props.onClose).toHaveBeenCalledWith("console:p1:1");
        fireEvent.contextMenu(screen.getByRole("tab", { name: "Analytics events" }));
        fireEvent.click(screen.getByText("Close others"));
        expect(props.onCloseOthers).toHaveBeenCalledWith("table:p2:main.events");
    });

    it("opens a new console", () => {
        const props = renderStrip();
        fireEvent.click(screen.getByRole("button", { name: "New console" }));
        expect(props.onNewConsole).toHaveBeenCalled();
    });
});

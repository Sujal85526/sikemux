import { afterEach, describe, expect, it } from "vitest";
import { captionStyle } from "./VoiceCaption";

function box(element: HTMLElement, rect: { left: number; top: number; width: number; height: number }) {
    element.getBoundingClientRect = () => ({
        ...rect,
        right: rect.left + rect.width,
        bottom: rect.top + rect.height,
        x: rect.left,
        y: rect.top,
        toJSON: () => rect,
    });
    return element;
}

afterEach(() => {
    document.body.innerHTML = "";
});

describe("captionStyle", () => {
    it("floats above a chat's composer so the mic and send buttons stay in view", () => {
        const pane = box(document.createElement("div"), { left: 100, top: 0, width: 600, height: 800 });
        const composer = box(document.createElement("div"), { left: 120, top: 680, width: 560, height: 110 });
        composer.className = "chat-composer";
        pane.append(composer);
        document.body.append(pane);
        expect(captionStyle(pane, 800)).toEqual({ left: 400, bottom: 800 - 680 + 12, maxWidth: 536 });
    });

    it("sits inside the bottom of any other field", () => {
        const field = box(document.createElement("textarea"), { left: 0, top: 500, width: 400, height: 100 });
        document.body.append(field);
        expect(captionStyle(field, 800)).toEqual({ left: 200, bottom: 800 - 600 + 12, maxWidth: 376 });
    });

    it("centres near the bottom of the window with no field to follow", () => {
        expect(captionStyle(null, 800)).toEqual({ left: "50%", bottom: 64 });
        expect(captionStyle(document.createElement("div"), 800)).toEqual({ left: "50%", bottom: 64 });
    });
});

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserApi, type AddressSuggestions } from "../api/browser";
import { useNativeViewHoles } from "../state/nativeViews";
import { AddressBar } from "./AddressBar";

vi.mock("../api/browser", async () => {
    const actual = await vi.importActual<typeof import("../api/browser")>("../api/browser");
    return { ...actual, browserApi: { suggest: vi.fn() } };
});

const youtube: AddressSuggestions = {
    completion: { url: "https://www.youtube.com/", title: "YouTube", address: "youtube.com/", icon: null },
    pages: [
        { url: "https://www.youtube.com/watch?v=abc", title: "KREAM - YouTube", address: "youtube.com/watch?v=abc", icon: null },
        {
            url: "https://studio.youtube.com/analytics",
            title: "Video analytics - YouTube Studio",
            address: "studio.youtube.com/analytics",
            icon: null,
        },
    ],
    searches: true,
    searchUrl: "https://www.google.com/search?q=you",
};

const onGo = vi.fn();
let holes: ReturnType<typeof useNativeViewHoles> = [];

function Holes() {
    holes = useNativeViewHoles();
    return null;
}

function renderBar(pageAddress = "https://example.com/") {
    render(
        <>
            <AddressBar tabId="tab-one" pageAddress={pageAddress} onGo={onGo} />
            <Holes />
        </>,
    );
    return screen.getByRole("textbox", { name: "Address and search" }) as HTMLInputElement;
}

async function type(input: HTMLInputElement, value: string, inputType = "insertText") {
    await act(async () => {
        fireEvent.input(input, { target: { value }, inputType });
    });
}

beforeEach(() => {
    vi.mocked(browserApi.suggest).mockResolvedValue(youtube);
});

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

describe("AddressBar", () => {
    it("finishes a remembered site in place and selects the part it added", async () => {
        const input = renderBar();
        input.focus();
        await type(input, "you");

        expect(browserApi.suggest).toHaveBeenCalledWith("you");
        expect(input).toHaveValue("youtube.com/");
        expect([input.selectionStart, input.selectionEnd]).toEqual([3, 12]);

        fireEvent.keyDown(input, { key: "Enter" });
        expect(onGo).toHaveBeenCalledWith("https://www.youtube.com/");
        expect(input).toHaveValue("https://example.com/");
    });

    it("lists the matching pages under the field, finished site first and a search last", async () => {
        const input = renderBar();
        input.focus();
        await type(input, "you");

        const options = screen.getAllByRole("option");
        expect(options.map((option) => option.textContent)).toEqual([
            "YouTube — youtube.com/",
            "KREAM - YouTube — youtube.com/watch?v=abc",
            "Video analytics - YouTube Studio — studio.youtube.com/analytics",
            "you — Google Search",
        ]);
        expect(options[0]).toHaveAttribute("aria-selected", "true");
        expect(holes).toHaveLength(1);
    });

    it("walks the list with the arrow keys and opens the one chosen", async () => {
        const input = renderBar();
        input.focus();
        await type(input, "you");

        fireEvent.keyDown(input, { key: "ArrowDown" });
        expect(input).toHaveValue("youtube.com/watch?v=abc");
        expect(screen.getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true");

        fireEvent.keyDown(input, { key: "Enter" });
        expect(onGo).toHaveBeenCalledWith("https://www.youtube.com/watch?v=abc");
        expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
        expect(holes).toEqual([]);
    });

    it("opens a page that is clicked without the field losing focus first", async () => {
        const input = renderBar();
        input.focus();
        await type(input, "you");

        const search = screen.getByRole("option", { name: /Google Search/ });
        expect(fireEvent.mouseDown(search)).toBe(false);
        fireEvent.click(search);
        expect(onGo).toHaveBeenCalledWith("https://www.google.com/search?q=you");
    });

    it("does not finish the address again after the finished part is deleted", async () => {
        const input = renderBar();
        input.focus();
        await type(input, "you");
        await type(input, "you", "deleteContentBackward");

        expect(input).toHaveValue("you");
        expect(screen.getAllByRole("option")[0]).toHaveTextContent("you — Google Search");
        fireEvent.keyDown(input, { key: "Enter" });
        expect(onGo).toHaveBeenCalledWith("https://www.google.com/search?q=you");
    });

    it("sends what was typed when nothing is remembered", async () => {
        vi.mocked(browserApi.suggest).mockResolvedValue({ completion: null, pages: [], searches: false, searchUrl: "" });
        const input = renderBar();
        input.focus();
        await type(input, "openai.com");

        expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
        fireEvent.keyDown(input, { key: "Enter" });
        expect(onGo).toHaveBeenCalledWith("openai.com");
    });

    it("ignores an answer that arrives after the typing has moved on", async () => {
        let answerFirst: (value: AddressSuggestions) => void = () => {};
        vi.mocked(browserApi.suggest)
            .mockImplementationOnce(() => new Promise((resolve) => (answerFirst = resolve)))
            .mockResolvedValueOnce({ ...youtube, completion: null, pages: [] });
        const input = renderBar();
        input.focus();
        await type(input, "y");
        await type(input, "yo");
        await act(async () => answerFirst(youtube));

        expect(input).toHaveValue("yo");
        expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });
});

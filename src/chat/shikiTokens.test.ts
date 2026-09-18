import { describe, expect, it } from "vitest";
import { tokenizeCode } from "./shikiTokens";
import { codeThemeName } from "../themes/codeTheme";
import { DEFAULT_THEME_ID, themeById } from "../themes";

const theme = themeById(DEFAULT_THEME_ID);
const name = codeThemeName(theme);

function tokens(lines: Awaited<ReturnType<typeof tokenizeCode>>) {
    return lines.flat();
}

describe("tokenizeCode", () => {
    it("colours code in the palette the diff panes use, and changes none of it", async () => {
        const source = "const answer = 42; // why\nexport default answer;";
        const lines = await tokenizeCode(source, "typescript", theme, name);

        expect(lines.map((line) => line.map((token) => token.text).join("")).join("\n")).toBe(source);
        const word = (text: string) => tokens(lines).find((token) => token.text.includes(text));
        expect(word("const")?.color?.toLowerCase()).toBe(theme.highlight.keyword.toLowerCase());
        expect(word("42")?.color?.toLowerCase()).toBe(theme.highlight.number.toLowerCase());
        expect(word("why")?.color?.toLowerCase()).toBe(theme.highlight.comment.toLowerCase());
        expect(word("why")?.italic).toBe(true);
    });

    it("leaves the plain words of a line uncoloured, so a fence keeps the weight it reads at", async () => {
        const lines = await tokenizeCode("body { color: red; }", "css", theme, name);
        expect(tokens(lines).some((token) => token.color === undefined)).toBe(true);
    });

    it("says nothing for a grammar it does not carry", async () => {
        expect(await tokenizeCode("SELECT 1", "cobol", theme, name)).toEqual([]);
    });
});

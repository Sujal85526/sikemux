import { html, htmlLanguage } from "@codemirror/lang-html";
import { javascript, typescriptLanguage } from "@codemirror/lang-javascript";
import { defineLanguageFacet, Language, LanguageSupport, languageDataProp } from "@codemirror/language";
import { NodeSet, NodeType, parseMixed, Parser, Tree, type Input, type PartialParse, type TreeFragment } from "@lezer/common";
import { styleTags, tags as t } from "@lezer/highlight";

const data = defineLanguageFacet({ commentTokens: { block: { open: "<!--", close: "-->" } } });

const nodes = new NodeSet([
    NodeType.define({ id: 0, name: "Document", top: true, props: [[languageDataProp, data]] }),
    NodeType.define({ id: 1, name: "Fence" }),
    NodeType.define({ id: 2, name: "Frontmatter" }),
    NodeType.define({ id: 3, name: "Markup" }),
]).extend(styleTags({ Fence: t.processingInstruction }));
const [Document, Fence, Frontmatter, Markup] = nodes.types;

const FRONTMATTER = /---[ \t]*\r?\n([\s\S]*?)^---[ \t]*$/my;

function outline(text: string): Tree {
    FRONTMATTER.lastIndex = 0;
    const match = FRONTMATTER.exec(text);
    if (!match) return new Tree(Document, [new Tree(Markup, [], [], text.length)], [0], text.length);
    const scriptFrom = text.indexOf("\n") + 1;
    const scriptTo = scriptFrom + match[1].length;
    const end = match[0].length;
    return new Tree(
        Document,
        [
            new Tree(Fence, [], [], scriptFrom),
            new Tree(Frontmatter, [], [], scriptTo - scriptFrom),
            new Tree(Fence, [], [], end - scriptTo),
            new Tree(Markup, [], [], text.length - end),
        ],
        [0, scriptFrom, scriptTo, end],
        text.length,
    );
}

const embed = parseMixed((node) => {
    if (node.type === Frontmatter) return { parser: typescriptLanguage.parser };
    if (node.type === Markup) return { parser: htmlLanguage.parser };
    return null;
});

class AstroParser extends Parser {
    createParse(input: Input, fragments: readonly TreeFragment[], ranges: readonly { from: number; to: number }[]): PartialParse {
        const whole: PartialParse = {
            parsedPos: input.length,
            stoppedAt: null,
            stopAt() {},
            advance: () => outline(input.read(0, input.length)),
        };
        return embed(whole, input, fragments, ranges);
    }
}

export const astroLanguage = new Language(data, new AstroParser(), [], "astro");

export function astro(): LanguageSupport {
    return new LanguageSupport(astroLanguage, [html().support, javascript({ typescript: true }).support]);
}

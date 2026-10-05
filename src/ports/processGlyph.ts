import { languageGlyph, type GlyphInfo } from "../ui/FileIcon";

const NODE: GlyphInfo = { char: "", color: "#5fa04e" };

const RUNTIMES: [RegExp, GlyphInfo | undefined][] = [
    [/^(node|next-server|nuxt|vite|npm|pnpm|yarn|bun|tsx|esbuild|webpack|astro|remix)\b/, NODE],
    [/^deno\b/, languageGlyph("typescript")],
    [/^(python[\d.]*|uvicorn|gunicorn|hypercorn|flask|django)\b/, languageGlyph("python")],
    [/^(ruby|puma|rails|unicorn)\b/, languageGlyph("ruby")],
    [/^(java|gradle|mvn)\b/, languageGlyph("java")],
    [/^(php|php-fpm)\b/, languageGlyph("php")],
    [/^(beam\.smp|elixir|mix)\b/, languageGlyph("elixir")],
    [/^(com\.docker|docker|vpnkit|orbstack)/, languageGlyph("docker")],
];

/** The runtime glyph for a listening process, or null when its name says nothing about one. */
export function processGlyph(process: string): GlyphInfo | null {
    const name = process.trim().toLowerCase().split("/").pop() ?? "";
    for (const [pattern, glyph] of RUNTIMES) if (pattern.test(name)) return glyph ?? null;
    return null;
}

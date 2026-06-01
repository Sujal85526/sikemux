interface GlyphInfo {
    char: string;
    color: string;
}

const DEFAULT: GlyphInfo = { char: "", color: "var(--ink-faint)" };

const SPECIAL: Record<string, GlyphInfo> = {
    "package.json": { char: "", color: "#cb3837" },
    "package-lock.json": { char: "", color: "#cbcb41" },
    "pnpm-lock.yaml": { char: "", color: "#f9ad00" },
    "yarn.lock": { char: "", color: "#2c8ebb" },
    dockerfile: { char: "", color: "#2496ed" },
    ".dockerignore": { char: "", color: "#2496ed" },
    makefile: { char: "", color: "#a4aa7b" },
    ".gitignore": { char: "", color: "#f05033" },
    ".gitattributes": { char: "", color: "#f05033" },
    ".gitmodules": { char: "", color: "#f05033" },
    "readme.md": { char: "", color: "#519aba" },
    readme: { char: "", color: "#519aba" },
    license: { char: "", color: "#cbcb41" },
    "tsconfig.json": { char: "", color: "#3178c6" },
    "tsconfig.node.json": { char: "", color: "#3178c6" },
    "vite.config.ts": { char: "", color: "#646cff" },
    "vite.config.js": { char: "", color: "#646cff" },
    "cargo.toml": { char: "", color: "#dea584" },
    "cargo.lock": { char: "", color: "#dea584" },
    "tauri.conf.json": { char: "", color: "#ffc131" },
    ".prettierrc": { char: "", color: "#c596c7" },
    ".eslintrc": { char: "", color: "#4b32c3" },
};

const BY_EXT: Record<string, GlyphInfo> = {
    ts: { char: "", color: "#3178c6" },
    tsx: { char: "", color: "#3178c6" },
    js: { char: "", color: "#f7df1e" },
    jsx: { char: "", color: "#f7df1e" },
    mjs: { char: "", color: "#f7df1e" },
    cjs: { char: "", color: "#f7df1e" },
    json: { char: "", color: "#fbbf24" },
    jsonc: { char: "", color: "#fbbf24" },
    html: { char: "", color: "#e34f26" },
    htm: { char: "", color: "#e34f26" },
    css: { char: "", color: "#1572b6" },
    scss: { char: "", color: "#cf649a" },
    sass: { char: "", color: "#cf649a" },
    less: { char: "", color: "#1d365d" },
    md: { char: "", color: "#519aba" },
    mdx: { char: "", color: "#519aba" },
    yaml: { char: "", color: "#cbcb41" },
    yml: { char: "", color: "#cbcb41" },
    toml: { char: "", color: "#9c4221" },
    rs: { char: "", color: "#dea584" },
    go: { char: "", color: "#00add8" },
    py: { char: "", color: "#3572a5" },
    pyc: { char: "", color: "#3572a5" },
    rb: { char: "", color: "#cc342d" },
    lua: { char: "", color: "#7884e7" },
    java: { char: "", color: "#ea2d2e" },
    kt: { char: "", color: "#f18e33" },
    swift: { char: "", color: "#f05138" },
    c: { char: "", color: "#599eff" },
    cpp: { char: "", color: "#9c033a" },
    cc: { char: "", color: "#9c033a" },
    h: { char: "", color: "#a074c4" },
    hpp: { char: "", color: "#a074c4" },
    sh: { char: "", color: "#89e051" },
    bash: { char: "", color: "#89e051" },
    zsh: { char: "", color: "#89e051" },
    fish: { char: "", color: "#89e051" },
    vim: { char: "", color: "#019733" },
    sql: { char: "", color: "#dad8d8" },
    tf: { char: "", color: "#7b42bc" },
    hcl: { char: "", color: "#7b42bc" },
    env: { char: "", color: "#ecd53f" },
    txt: { char: "", color: "#888" },
    log: { char: "", color: "#888" },
    pdf: { char: "", color: "#e94e4e" },
    png: { char: "", color: "#a074c4" },
    jpg: { char: "", color: "#a074c4" },
    jpeg: { char: "", color: "#a074c4" },
    gif: { char: "", color: "#a074c4" },
    webp: { char: "", color: "#a074c4" },
    ico: { char: "", color: "#a074c4" },
    svg: { char: "", color: "#ffb13b" },
    zip: { char: "", color: "#888" },
    tar: { char: "", color: "#888" },
    gz: { char: "", color: "#888" },
    woff: { char: "", color: "#888" },
    woff2: { char: "", color: "#888" },
    ttf: { char: "", color: "#888" },
    otf: { char: "", color: "#888" },
};

function lookup(name: string): GlyphInfo {
    const lower = name.toLowerCase();
    if (SPECIAL[lower]) return SPECIAL[lower];
    if (lower.startsWith(".env")) return { char: "", color: "#ecd53f" };
    const i = name.lastIndexOf(".");
    if (i < 0 || i === 0) return DEFAULT;
    return BY_EXT[name.slice(i + 1).toLowerCase()] ?? DEFAULT;
}

export function FileIcon({ name, size = 15 }: { name: string; size?: number }) {
    const { char, color } = lookup(name);
    return (
        <span className="file-glyph" style={{ color, fontSize: size }} aria-hidden="true">
            {char}
        </span>
    );
}

import { GRAMMAR_ALIASES, GRAMMARS } from "./generated/grammars";

/** Files known by their whole name rather than by an extension. */
const FILE_NAMES: Readonly<Record<string, string>> = {
    ".editorconfig": "ini",
    ".env": "dotenv",
    "cmakelists.txt": "cmake",
    codeowners: "codeowners",
    containerfile: "docker",
    gemfile: "ruby",
    gnumakefile: "make",
    rakefile: "ruby",
    ssh_config: "ssh-config",
};

/** Extensions that are neither a grammar's name nor one of its aliases. */
const EXTENSIONS: Readonly<Record<string, string>> = {
    cc: "cpp",
    cfg: "ini",
    cxx: "cpp",
    env: "dotenv",
    ex: "elixir",
    exs: "elixir",
    fsx: "fsharp",
    gradle: "groovy",
    h: "c",
    hh: "cpp",
    hpp: "cpp",
    htm: "html",
    m: "objective-c",
    mk: "make",
    ml: "ocaml",
    mli: "ocaml",
    mm: "objective-cpp",
    patch: "diff",
    plist: "xml",
    pyi: "python",
    pyw: "python",
    sol: "solidity",
    svg: "xml",
    vhd: "vhdl",
    xhtml: "html",
};

/** The app ships the TypeScript grammar, and it reads JavaScript well enough to spare a download. */
const SHIPPED_STAND_INS: Readonly<Record<string, string>> = {
    javascript: "typescript",
    jsx: "typescript",
    tsx: "typescript",
};

function known(name: string): string | null {
    if (Object.hasOwn(GRAMMARS, name)) return name;
    return Object.hasOwn(GRAMMAR_ALIASES, name) ? GRAMMAR_ALIASES[name] : null;
}

/** The grammar for a language's name, a file name or a path, which may end in `:line` or `:line:column`. */
export function grammarFor(nameOrPath: string): string | null {
    const name = (nameOrPath.toLowerCase().split(/[\\/]/).pop() ?? "").replace(/:\d+(?::\d+)?$/, "");
    const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
    const id =
        (Object.hasOwn(FILE_NAMES, name) ? FILE_NAMES[name] : null) ??
        (name.startsWith("dockerfile") ? "docker" : null) ??
        (name.startsWith(".env.") ? "dotenv" : null) ??
        known(name) ??
        (Object.hasOwn(EXTENSIONS, extension) ? EXTENSIONS[extension] : null) ??
        (extension ? known(extension) : null);
    if (!id) return null;
    return Object.hasOwn(SHIPPED_STAND_INS, id) ? SHIPPED_STAND_INS[id] : id;
}

export interface ThemeChrome {
    bg: string;
    bgDim: string;
    bgRaised: string;
    ink: string;
    inkDim: string;
    inkMuted: string;
    acc: string;
    accLine: string;
    accDim: string;
    line: string;
    hl: string;
    danger: string;
}

export interface ThemeEditor {
    fg: string;
    bg: string;
    caret: string;
    selection: string;
    activeLine: string;
    gutter: string;
    gutterActive: string;
    indent: string;
    indentActive: string;
}

export interface ThemeHighlight {
    keyword: string;
    string: string;
    comment: string;
    number: string;
    function: string;
    type: string;
    variable: string;
    property: string;
    tag: string;
    operator: string;
    link: string;
    invalid: string;
    meta: string;
    heading: string;
}

export interface ThemeTerminal {
    background: string;
    foreground: string;
    cursor: string;
    cursorAccent: string;
    selectionBackground: string;
    black: string;
    red: string;
    green: string;
    yellow: string;
    blue: string;
    magenta: string;
    cyan: string;
    white: string;
    brightBlack: string;
    brightRed: string;
    brightGreen: string;
    brightYellow: string;
    brightBlue: string;
    brightMagenta: string;
    brightCyan: string;
    brightWhite: string;
}

export interface Theme {
    id: string;
    name: string;
    dark: boolean;
    chrome: ThemeChrome;
    editor: ThemeEditor;
    highlight: ThemeHighlight;
    terminal: ThemeTerminal;
}

const CHROME_KEYS = ["bg", "bgDim", "bgRaised", "ink", "inkDim", "inkMuted", "acc", "accLine", "accDim", "line", "hl", "danger"] as const;
const EDITOR_KEYS = ["fg", "bg", "caret", "selection", "activeLine", "gutter", "gutterActive", "indent", "indentActive"] as const;
const HIGHLIGHT_KEYS = [
    "keyword",
    "string",
    "comment",
    "number",
    "function",
    "type",
    "variable",
    "property",
    "tag",
    "operator",
    "link",
    "invalid",
    "meta",
    "heading",
] as const;
const TERMINAL_KEYS = [
    "background",
    "foreground",
    "cursor",
    "cursorAccent",
    "selectionBackground",
    "black",
    "red",
    "green",
    "yellow",
    "blue",
    "magenta",
    "cyan",
    "white",
    "brightBlack",
    "brightRed",
    "brightGreen",
    "brightYellow",
    "brightBlue",
    "brightMagenta",
    "brightCyan",
    "brightWhite",
] as const;

type StringMap<K extends readonly string[]> = { [P in K[number]]: string };
const fromTuple = <K extends readonly string[]>(keys: K, values: readonly string[]): StringMap<K> =>
    Object.fromEntries(keys.map((k, i) => [k, values[i]])) as StringMap<K>;

const theme = (
    id: string,
    name: string,
    chrome: readonly string[],
    editor: readonly string[],
    highlight: readonly string[],
    terminal: readonly string[],
): Theme => ({
    id,
    name,
    dark: true,
    chrome: fromTuple(CHROME_KEYS, chrome),
    editor: fromTuple(EDITOR_KEYS, editor),
    highlight: fromTuple(HIGHLIGHT_KEYS, highlight),
    terminal: fromTuple(TERMINAL_KEYS, terminal),
});

const THEME_DATA = [
    [
        "aura",
        "Aura",
        [
            "#15121e",
            "#0c0b10",
            "#1c1929",
            "#e7e5ef",
            "#8b8898",
            "#565461",
            "#a277ff",
            "rgba(162,119,255,0.30)",
            "rgba(162,119,255,0.10)",
            "#242130",
            "rgba(162,119,255,0.055)",
            "#ff6767",
        ],
        ["#e7e5ef", "transparent", "#a277ff", "#352f4f", "rgba(162,119,255,0.055)", "#48464f", "#a277ff", "#242130", "#3a3550"],
        [
            "#a277ff",
            "#61ffca",
            "#565461",
            "#ffca85",
            "#ff6ac1",
            "#ffca85",
            "#e7e5ef",
            "#82d9ff",
            "#ff6ac1",
            "#8b8898",
            "#61ffca",
            "#ff6767",
            "#8b8898",
            "#a277ff",
        ],
        [
            "#15121e",
            "#e7e5ef",
            "#a277ff",
            "#15121e",
            "#352f4f",
            "#110f18",
            "#ff6767",
            "#61ffca",
            "#ffca85",
            "#82d9ff",
            "#a277ff",
            "#61ffca",
            "#e7e5ef",
            "#565461",
            "#ff6ac1",
            "#61ffca",
            "#ffca85",
            "#82d9ff",
            "#a277ff",
            "#61ffca",
            "#ffffff",
        ],
    ],
    [
        "ayu-dark",
        "Ayu Dark",
        [
            "#0b0e14",
            "#0a0d12",
            "#11151c",
            "#bfbdb6",
            "#565b66",
            "#3d4149",
            "#e6b450",
            "rgba(230,180,80,0.30)",
            "rgba(230,180,80,0.10)",
            "#1f2430",
            "rgba(230,180,80,0.055)",
            "#f07178",
        ],
        ["#bfbdb6", "transparent", "#e6b450", "#1f2430", "rgba(230,180,80,0.055)", "#3d4149", "#e6b450", "#1f2430", "#2d333f"],
        [
            "#ff8f40",
            "#aad94c",
            "#5c6773",
            "#d2a6ff",
            "#ffb454",
            "#59c2ff",
            "#bfbdb6",
            "#59c2ff",
            "#39bae6",
            "#f29668",
            "#aad94c",
            "#f07178",
            "#5c6773",
            "#e6b450",
        ],
        [
            "#0b0e14",
            "#bfbdb6",
            "#e6b450",
            "#0b0e14",
            "#1f2430",
            "#11151c",
            "#f07178",
            "#aad94c",
            "#ffb454",
            "#59c2ff",
            "#d2a6ff",
            "#95e6cb",
            "#bfbdb6",
            "#3d4149",
            "#f07178",
            "#aad94c",
            "#ffb454",
            "#59c2ff",
            "#d2a6ff",
            "#95e6cb",
            "#ffffff",
        ],
    ],
    [
        "tokyo-night",
        "Tokyo Night",
        [
            "#1a1b26",
            "#16161e",
            "#1f2335",
            "#c0caf5",
            "#787c99",
            "#414868",
            "#7aa2f7",
            "rgba(122,162,247,0.30)",
            "rgba(122,162,247,0.10)",
            "#292e42",
            "rgba(122,162,247,0.06)",
            "#f7768e",
        ],
        ["#c0caf5", "transparent", "#7aa2f7", "#283457", "rgba(122,162,247,0.06)", "#3b4261", "#7aa2f7", "#292e42", "#3b4261"],
        [
            "#bb9af7",
            "#9ece6a",
            "#565f89",
            "#ff9e64",
            "#7aa2f7",
            "#2ac3de",
            "#c0caf5",
            "#7dcfff",
            "#f7768e",
            "#89ddff",
            "#9ece6a",
            "#f7768e",
            "#565f89",
            "#7aa2f7",
        ],
        [
            "#1a1b26",
            "#c0caf5",
            "#7aa2f7",
            "#1a1b26",
            "#283457",
            "#15161e",
            "#f7768e",
            "#9ece6a",
            "#e0af68",
            "#7aa2f7",
            "#bb9af7",
            "#7dcfff",
            "#a9b1d6",
            "#414868",
            "#f7768e",
            "#9ece6a",
            "#e0af68",
            "#7aa2f7",
            "#bb9af7",
            "#7dcfff",
            "#c0caf5",
        ],
    ],
    [
        "catppuccin-mocha",
        "Catppuccin Mocha",
        [
            "#1e1e2e",
            "#181825",
            "#313244",
            "#cdd6f4",
            "#7f849c",
            "#45475a",
            "#cba6f7",
            "rgba(203,166,247,0.30)",
            "rgba(203,166,247,0.10)",
            "#313244",
            "rgba(203,166,247,0.06)",
            "#f38ba8",
        ],
        ["#cdd6f4", "transparent", "#cba6f7", "#45475a", "rgba(203,166,247,0.06)", "#585b70", "#cba6f7", "#313244", "#45475a"],
        [
            "#cba6f7",
            "#a6e3a1",
            "#6c7086",
            "#fab387",
            "#89b4fa",
            "#f9e2af",
            "#cdd6f4",
            "#89dceb",
            "#f38ba8",
            "#94e2d5",
            "#a6e3a1",
            "#f38ba8",
            "#6c7086",
            "#cba6f7",
        ],
        [
            "#1e1e2e",
            "#cdd6f4",
            "#cba6f7",
            "#1e1e2e",
            "#45475a",
            "#45475a",
            "#f38ba8",
            "#a6e3a1",
            "#f9e2af",
            "#89b4fa",
            "#cba6f7",
            "#89dceb",
            "#bac2de",
            "#585b70",
            "#f38ba8",
            "#a6e3a1",
            "#f9e2af",
            "#89b4fa",
            "#cba6f7",
            "#89dceb",
            "#a6adc8",
        ],
    ],
    [
        "dracula",
        "Dracula",
        [
            "#282a36",
            "#1e1f29",
            "#343746",
            "#f8f8f2",
            "#a09fb3",
            "#6272a4",
            "#bd93f9",
            "rgba(189,147,249,0.30)",
            "rgba(189,147,249,0.10)",
            "#44475a",
            "rgba(189,147,249,0.06)",
            "#ff5555",
        ],
        ["#f8f8f2", "transparent", "#bd93f9", "#44475a", "rgba(189,147,249,0.06)", "#6272a4", "#bd93f9", "#44475a", "#5a5e7c"],
        [
            "#ff79c6",
            "#f1fa8c",
            "#6272a4",
            "#bd93f9",
            "#50fa7b",
            "#8be9fd",
            "#f8f8f2",
            "#8be9fd",
            "#ff79c6",
            "#ff79c6",
            "#8be9fd",
            "#ff5555",
            "#6272a4",
            "#bd93f9",
        ],
        [
            "#282a36",
            "#f8f8f2",
            "#bd93f9",
            "#282a36",
            "#44475a",
            "#21222c",
            "#ff5555",
            "#50fa7b",
            "#f1fa8c",
            "#bd93f9",
            "#ff79c6",
            "#8be9fd",
            "#f8f8f2",
            "#6272a4",
            "#ff6e6e",
            "#69ff94",
            "#ffffa5",
            "#d6acff",
            "#ff92df",
            "#a4ffff",
            "#ffffff",
        ],
    ],
    [
        "gruvbox-dark",
        "Gruvbox Dark",
        [
            "#282828",
            "#1d2021",
            "#3c3836",
            "#ebdbb2",
            "#a89984",
            "#665c54",
            "#fabd2f",
            "rgba(250,189,47,0.30)",
            "rgba(250,189,47,0.10)",
            "#3c3836",
            "rgba(250,189,47,0.06)",
            "#fb4934",
        ],
        ["#ebdbb2", "transparent", "#fabd2f", "#504945", "rgba(250,189,47,0.06)", "#7c6f64", "#fabd2f", "#3c3836", "#504945"],
        [
            "#fb4934",
            "#b8bb26",
            "#928374",
            "#d3869b",
            "#b8bb26",
            "#fabd2f",
            "#ebdbb2",
            "#83a598",
            "#8ec07c",
            "#fe8019",
            "#83a598",
            "#fb4934",
            "#928374",
            "#fabd2f",
        ],
        [
            "#282828",
            "#ebdbb2",
            "#fabd2f",
            "#282828",
            "#504945",
            "#282828",
            "#cc241d",
            "#98971a",
            "#d79921",
            "#458588",
            "#b16286",
            "#689d6a",
            "#a89984",
            "#928374",
            "#fb4934",
            "#b8bb26",
            "#fabd2f",
            "#83a598",
            "#d3869b",
            "#8ec07c",
            "#ebdbb2",
        ],
    ],
    [
        "nord",
        "Nord",
        [
            "#2e3440",
            "#242933",
            "#3b4252",
            "#eceff4",
            "#9aa3b3",
            "#4c566a",
            "#88c0d0",
            "rgba(136,192,208,0.30)",
            "rgba(136,192,208,0.10)",
            "#3b4252",
            "rgba(136,192,208,0.06)",
            "#bf616a",
        ],
        ["#eceff4", "transparent", "#88c0d0", "#434c5e", "rgba(136,192,208,0.06)", "#4c566a", "#88c0d0", "#3b4252", "#4c566a"],
        [
            "#81a1c1",
            "#a3be8c",
            "#616e88",
            "#b48ead",
            "#88c0d0",
            "#8fbcbb",
            "#eceff4",
            "#d8dee9",
            "#81a1c1",
            "#81a1c1",
            "#88c0d0",
            "#bf616a",
            "#616e88",
            "#88c0d0",
        ],
        [
            "#2e3440",
            "#eceff4",
            "#88c0d0",
            "#2e3440",
            "#434c5e",
            "#3b4252",
            "#bf616a",
            "#a3be8c",
            "#ebcb8b",
            "#81a1c1",
            "#b48ead",
            "#88c0d0",
            "#e5e9f0",
            "#4c566a",
            "#bf616a",
            "#a3be8c",
            "#ebcb8b",
            "#81a1c1",
            "#b48ead",
            "#8fbcbb",
            "#eceff4",
        ],
    ],
    [
        "one-dark",
        "One Dark",
        [
            "#282c34",
            "#21252b",
            "#3a3f4b",
            "#abb2bf",
            "#7f848e",
            "#5c6370",
            "#61afef",
            "rgba(97,175,239,0.30)",
            "rgba(97,175,239,0.10)",
            "#3e4451",
            "rgba(97,175,239,0.06)",
            "#e06c75",
        ],
        ["#abb2bf", "transparent", "#61afef", "#3e4451", "rgba(97,175,239,0.06)", "#4b5263", "#61afef", "#3e4451", "#5c6370"],
        [
            "#c678dd",
            "#98c379",
            "#5c6370",
            "#d19a66",
            "#61afef",
            "#e5c07b",
            "#abb2bf",
            "#e06c75",
            "#e06c75",
            "#56b6c2",
            "#98c379",
            "#e06c75",
            "#5c6370",
            "#61afef",
        ],
        [
            "#282c34",
            "#abb2bf",
            "#61afef",
            "#282c34",
            "#3e4451",
            "#282c34",
            "#e06c75",
            "#98c379",
            "#e5c07b",
            "#61afef",
            "#c678dd",
            "#56b6c2",
            "#dcdfe4",
            "#5c6370",
            "#e06c75",
            "#98c379",
            "#e5c07b",
            "#61afef",
            "#c678dd",
            "#56b6c2",
            "#ffffff",
        ],
    ],
    [
        "solarized-dark",
        "Solarized Dark",
        [
            "#002b36",
            "#001f27",
            "#073642",
            "#eee8d5",
            "#93a1a1",
            "#586e75",
            "#268bd2",
            "rgba(38,139,210,0.30)",
            "rgba(38,139,210,0.10)",
            "#073642",
            "rgba(38,139,210,0.06)",
            "#dc322f",
        ],
        ["#eee8d5", "transparent", "#268bd2", "#073642", "rgba(38,139,210,0.06)", "#586e75", "#268bd2", "#073642", "#586e75"],
        [
            "#859900",
            "#2aa198",
            "#586e75",
            "#d33682",
            "#268bd2",
            "#b58900",
            "#eee8d5",
            "#268bd2",
            "#268bd2",
            "#cb4b16",
            "#2aa198",
            "#dc322f",
            "#586e75",
            "#268bd2",
        ],
        [
            "#002b36",
            "#eee8d5",
            "#268bd2",
            "#002b36",
            "#073642",
            "#073642",
            "#dc322f",
            "#859900",
            "#b58900",
            "#268bd2",
            "#d33682",
            "#2aa198",
            "#eee8d5",
            "#586e75",
            "#cb4b16",
            "#586e75",
            "#657b83",
            "#839496",
            "#6c71c4",
            "#93a1a1",
            "#fdf6e3",
        ],
    ],
] as const;

export const THEMES: Theme[] = THEME_DATA.map(([id, name, chrome, editor, highlight, terminal]) =>
    theme(id, name, chrome, editor, highlight, terminal),
);

export const THEMES_BY_ID: Record<string, Theme> = Object.fromEntries(THEMES.map((t) => [t.id, t]));

export const DEFAULT_THEME_ID = "aura";

export function themeById(id: string): Theme {
    return THEMES_BY_ID[id] ?? THEMES_BY_ID[DEFAULT_THEME_ID];
}

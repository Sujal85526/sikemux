// Theme catalog. Each theme defines every color slot the app needs in one
// place: chrome (CSS variables on :root), editor (CodeMirror), and terminal
// (xterm.js).
//
// Adding more themes: copy any base16 scheme into this shape — bases 00-07
// drive chrome + editor neutrals, bases 08-0F drive syntax / ansi.
//   reference: https://github.com/chriskempson/base16
//   browse:    https://github.com/mbadolato/iTerm2-Color-Schemes  (300+ themes)

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

// ---- themes -------------------------------------------------------------

const aura: Theme = {
    id: "aura",
    name: "Aura",
    dark: true,
    chrome: {
        bg: "#15121e",
        bgDim: "#0c0b10",
        bgRaised: "#1c1929",
        ink: "#e7e5ef",
        inkDim: "#8b8898",
        inkMuted: "#565461",
        acc: "#a277ff",
        accLine: "rgba(162,119,255,0.30)",
        accDim: "rgba(162,119,255,0.10)",
        line: "#242130",
        hl: "rgba(162,119,255,0.055)",
        danger: "#ff6767",
    },
    editor: {
        fg: "#e7e5ef",
        bg: "transparent",
        caret: "#a277ff",
        selection: "#352f4f",
        activeLine: "rgba(162,119,255,0.055)",
        gutter: "#48464f",
        gutterActive: "#a277ff",
        indent: "#242130",
        indentActive: "#3a3550",
    },
    highlight: {
        keyword: "#a277ff",
        string: "#61ffca",
        comment: "#565461",
        number: "#ffca85",
        function: "#ff6ac1",
        type: "#ffca85",
        variable: "#e7e5ef",
        property: "#82d9ff",
        tag: "#ff6ac1",
        operator: "#8b8898",
        link: "#61ffca",
        invalid: "#ff6767",
        meta: "#8b8898",
        heading: "#a277ff",
    },
    terminal: {
        background: "#15121e",
        foreground: "#e7e5ef",
        cursor: "#a277ff",
        cursorAccent: "#15121e",
        selectionBackground: "#352f4f",
        black: "#110f18",
        red: "#ff6767",
        green: "#61ffca",
        yellow: "#ffca85",
        blue: "#82d9ff",
        magenta: "#a277ff",
        cyan: "#61ffca",
        white: "#e7e5ef",
        brightBlack: "#565461",
        brightRed: "#ff6ac1",
        brightGreen: "#61ffca",
        brightYellow: "#ffca85",
        brightBlue: "#82d9ff",
        brightMagenta: "#a277ff",
        brightCyan: "#61ffca",
        brightWhite: "#ffffff",
    },
};

const ayuDark: Theme = {
    id: "ayu-dark",
    name: "Ayu Dark",
    dark: true,
    chrome: {
        bg: "#0b0e14",
        bgDim: "#0a0d12",
        bgRaised: "#11151c",
        ink: "#bfbdb6",
        inkDim: "#565b66",
        inkMuted: "#3d4149",
        acc: "#e6b450",
        accLine: "rgba(230,180,80,0.30)",
        accDim: "rgba(230,180,80,0.10)",
        line: "#1f2430",
        hl: "rgba(230,180,80,0.055)",
        danger: "#f07178",
    },
    editor: {
        fg: "#bfbdb6",
        bg: "transparent",
        caret: "#e6b450",
        selection: "#1f2430",
        activeLine: "rgba(230,180,80,0.055)",
        gutter: "#3d4149",
        gutterActive: "#e6b450",
        indent: "#1f2430",
        indentActive: "#2d333f",
    },
    highlight: {
        keyword: "#ff8f40",
        string: "#aad94c",
        comment: "#5c6773",
        number: "#d2a6ff",
        function: "#ffb454",
        type: "#59c2ff",
        variable: "#bfbdb6",
        // Ayu's spec leaves property + variable at fg; VSCode rescues this with
        // LSP semantic tokens. We don't have those, so member access would look
        // flat. Use Ayu's entity color so `obj.method` reads cleanly.
        property: "#59c2ff",
        tag: "#39bae6",
        operator: "#f29668",
        link: "#aad94c",
        invalid: "#f07178",
        meta: "#5c6773",
        heading: "#e6b450",
    },
    terminal: {
        background: "#0b0e14",
        foreground: "#bfbdb6",
        cursor: "#e6b450",
        cursorAccent: "#0b0e14",
        selectionBackground: "#1f2430",
        black: "#11151c",
        red: "#f07178",
        green: "#aad94c",
        yellow: "#ffb454",
        blue: "#59c2ff",
        magenta: "#d2a6ff",
        cyan: "#95e6cb",
        white: "#bfbdb6",
        brightBlack: "#3d4149",
        brightRed: "#f07178",
        brightGreen: "#aad94c",
        brightYellow: "#ffb454",
        brightBlue: "#59c2ff",
        brightMagenta: "#d2a6ff",
        brightCyan: "#95e6cb",
        brightWhite: "#ffffff",
    },
};

const tokyoNight: Theme = {
    id: "tokyo-night",
    name: "Tokyo Night",
    dark: true,
    chrome: {
        bg: "#1a1b26",
        bgDim: "#16161e",
        bgRaised: "#1f2335",
        ink: "#c0caf5",
        inkDim: "#787c99",
        inkMuted: "#414868",
        acc: "#7aa2f7",
        accLine: "rgba(122,162,247,0.30)",
        accDim: "rgba(122,162,247,0.10)",
        line: "#292e42",
        hl: "rgba(122,162,247,0.06)",
        danger: "#f7768e",
    },
    editor: {
        fg: "#c0caf5",
        bg: "transparent",
        caret: "#7aa2f7",
        selection: "#283457",
        activeLine: "rgba(122,162,247,0.06)",
        gutter: "#3b4261",
        gutterActive: "#7aa2f7",
        indent: "#292e42",
        indentActive: "#3b4261",
    },
    highlight: {
        keyword: "#bb9af7",
        string: "#9ece6a",
        comment: "#565f89",
        number: "#ff9e64",
        function: "#7aa2f7",
        type: "#2ac3de",
        variable: "#c0caf5",
        property: "#7dcfff",
        tag: "#f7768e",
        operator: "#89ddff",
        link: "#9ece6a",
        invalid: "#f7768e",
        meta: "#565f89",
        heading: "#7aa2f7",
    },
    terminal: {
        background: "#1a1b26",
        foreground: "#c0caf5",
        cursor: "#7aa2f7",
        cursorAccent: "#1a1b26",
        selectionBackground: "#283457",
        black: "#15161e",
        red: "#f7768e",
        green: "#9ece6a",
        yellow: "#e0af68",
        blue: "#7aa2f7",
        magenta: "#bb9af7",
        cyan: "#7dcfff",
        white: "#a9b1d6",
        brightBlack: "#414868",
        brightRed: "#f7768e",
        brightGreen: "#9ece6a",
        brightYellow: "#e0af68",
        brightBlue: "#7aa2f7",
        brightMagenta: "#bb9af7",
        brightCyan: "#7dcfff",
        brightWhite: "#c0caf5",
    },
};

const catppuccin: Theme = {
    id: "catppuccin-mocha",
    name: "Catppuccin Mocha",
    dark: true,
    chrome: {
        bg: "#1e1e2e",
        bgDim: "#181825",
        bgRaised: "#313244",
        ink: "#cdd6f4",
        inkDim: "#7f849c",
        inkMuted: "#45475a",
        acc: "#cba6f7",
        accLine: "rgba(203,166,247,0.30)",
        accDim: "rgba(203,166,247,0.10)",
        line: "#313244",
        hl: "rgba(203,166,247,0.06)",
        danger: "#f38ba8",
    },
    editor: {
        fg: "#cdd6f4",
        bg: "transparent",
        caret: "#cba6f7",
        selection: "#45475a",
        activeLine: "rgba(203,166,247,0.06)",
        gutter: "#585b70",
        gutterActive: "#cba6f7",
        indent: "#313244",
        indentActive: "#45475a",
    },
    highlight: {
        keyword: "#cba6f7",
        string: "#a6e3a1",
        comment: "#6c7086",
        number: "#fab387",
        function: "#89b4fa",
        type: "#f9e2af",
        variable: "#cdd6f4",
        property: "#89dceb",
        tag: "#f38ba8",
        operator: "#94e2d5",
        link: "#a6e3a1",
        invalid: "#f38ba8",
        meta: "#6c7086",
        heading: "#cba6f7",
    },
    terminal: {
        background: "#1e1e2e",
        foreground: "#cdd6f4",
        cursor: "#cba6f7",
        cursorAccent: "#1e1e2e",
        selectionBackground: "#45475a",
        black: "#45475a",
        red: "#f38ba8",
        green: "#a6e3a1",
        yellow: "#f9e2af",
        blue: "#89b4fa",
        magenta: "#cba6f7",
        cyan: "#89dceb",
        white: "#bac2de",
        brightBlack: "#585b70",
        brightRed: "#f38ba8",
        brightGreen: "#a6e3a1",
        brightYellow: "#f9e2af",
        brightBlue: "#89b4fa",
        brightMagenta: "#cba6f7",
        brightCyan: "#89dceb",
        brightWhite: "#a6adc8",
    },
};

const dracula: Theme = {
    id: "dracula",
    name: "Dracula",
    dark: true,
    chrome: {
        bg: "#282a36",
        bgDim: "#1e1f29",
        bgRaised: "#343746",
        ink: "#f8f8f2",
        inkDim: "#a09fb3",
        inkMuted: "#6272a4",
        acc: "#bd93f9",
        accLine: "rgba(189,147,249,0.30)",
        accDim: "rgba(189,147,249,0.10)",
        line: "#44475a",
        hl: "rgba(189,147,249,0.06)",
        danger: "#ff5555",
    },
    editor: {
        fg: "#f8f8f2",
        bg: "transparent",
        caret: "#bd93f9",
        selection: "#44475a",
        activeLine: "rgba(189,147,249,0.06)",
        gutter: "#6272a4",
        gutterActive: "#bd93f9",
        indent: "#44475a",
        indentActive: "#5a5e7c",
    },
    highlight: {
        keyword: "#ff79c6",
        string: "#f1fa8c",
        comment: "#6272a4",
        number: "#bd93f9",
        function: "#50fa7b",
        type: "#8be9fd",
        variable: "#f8f8f2",
        property: "#8be9fd",
        tag: "#ff79c6",
        operator: "#ff79c6",
        link: "#8be9fd",
        invalid: "#ff5555",
        meta: "#6272a4",
        heading: "#bd93f9",
    },
    terminal: {
        background: "#282a36",
        foreground: "#f8f8f2",
        cursor: "#bd93f9",
        cursorAccent: "#282a36",
        selectionBackground: "#44475a",
        black: "#21222c",
        red: "#ff5555",
        green: "#50fa7b",
        yellow: "#f1fa8c",
        blue: "#bd93f9",
        magenta: "#ff79c6",
        cyan: "#8be9fd",
        white: "#f8f8f2",
        brightBlack: "#6272a4",
        brightRed: "#ff6e6e",
        brightGreen: "#69ff94",
        brightYellow: "#ffffa5",
        brightBlue: "#d6acff",
        brightMagenta: "#ff92df",
        brightCyan: "#a4ffff",
        brightWhite: "#ffffff",
    },
};

const gruvboxDark: Theme = {
    id: "gruvbox-dark",
    name: "Gruvbox Dark",
    dark: true,
    chrome: {
        bg: "#282828",
        bgDim: "#1d2021",
        bgRaised: "#3c3836",
        ink: "#ebdbb2",
        inkDim: "#a89984",
        inkMuted: "#665c54",
        acc: "#fabd2f",
        accLine: "rgba(250,189,47,0.30)",
        accDim: "rgba(250,189,47,0.10)",
        line: "#3c3836",
        hl: "rgba(250,189,47,0.06)",
        danger: "#fb4934",
    },
    editor: {
        fg: "#ebdbb2",
        bg: "transparent",
        caret: "#fabd2f",
        selection: "#504945",
        activeLine: "rgba(250,189,47,0.06)",
        gutter: "#7c6f64",
        gutterActive: "#fabd2f",
        indent: "#3c3836",
        indentActive: "#504945",
    },
    highlight: {
        keyword: "#fb4934",
        string: "#b8bb26",
        comment: "#928374",
        number: "#d3869b",
        function: "#b8bb26",
        type: "#fabd2f",
        variable: "#ebdbb2",
        property: "#83a598",
        tag: "#8ec07c",
        operator: "#fe8019",
        link: "#83a598",
        invalid: "#fb4934",
        meta: "#928374",
        heading: "#fabd2f",
    },
    terminal: {
        background: "#282828",
        foreground: "#ebdbb2",
        cursor: "#fabd2f",
        cursorAccent: "#282828",
        selectionBackground: "#504945",
        black: "#282828",
        red: "#cc241d",
        green: "#98971a",
        yellow: "#d79921",
        blue: "#458588",
        magenta: "#b16286",
        cyan: "#689d6a",
        white: "#a89984",
        brightBlack: "#928374",
        brightRed: "#fb4934",
        brightGreen: "#b8bb26",
        brightYellow: "#fabd2f",
        brightBlue: "#83a598",
        brightMagenta: "#d3869b",
        brightCyan: "#8ec07c",
        brightWhite: "#ebdbb2",
    },
};

const nord: Theme = {
    id: "nord",
    name: "Nord",
    dark: true,
    chrome: {
        bg: "#2e3440",
        bgDim: "#242933",
        bgRaised: "#3b4252",
        ink: "#eceff4",
        inkDim: "#9aa3b3",
        inkMuted: "#4c566a",
        acc: "#88c0d0",
        accLine: "rgba(136,192,208,0.30)",
        accDim: "rgba(136,192,208,0.10)",
        line: "#3b4252",
        hl: "rgba(136,192,208,0.06)",
        danger: "#bf616a",
    },
    editor: {
        fg: "#eceff4",
        bg: "transparent",
        caret: "#88c0d0",
        selection: "#434c5e",
        activeLine: "rgba(136,192,208,0.06)",
        gutter: "#4c566a",
        gutterActive: "#88c0d0",
        indent: "#3b4252",
        indentActive: "#4c566a",
    },
    highlight: {
        keyword: "#81a1c1",
        string: "#a3be8c",
        comment: "#616e88",
        number: "#b48ead",
        function: "#88c0d0",
        type: "#8fbcbb",
        variable: "#eceff4",
        property: "#d8dee9",
        tag: "#81a1c1",
        operator: "#81a1c1",
        link: "#88c0d0",
        invalid: "#bf616a",
        meta: "#616e88",
        heading: "#88c0d0",
    },
    terminal: {
        background: "#2e3440",
        foreground: "#eceff4",
        cursor: "#88c0d0",
        cursorAccent: "#2e3440",
        selectionBackground: "#434c5e",
        black: "#3b4252",
        red: "#bf616a",
        green: "#a3be8c",
        yellow: "#ebcb8b",
        blue: "#81a1c1",
        magenta: "#b48ead",
        cyan: "#88c0d0",
        white: "#e5e9f0",
        brightBlack: "#4c566a",
        brightRed: "#bf616a",
        brightGreen: "#a3be8c",
        brightYellow: "#ebcb8b",
        brightBlue: "#81a1c1",
        brightMagenta: "#b48ead",
        brightCyan: "#8fbcbb",
        brightWhite: "#eceff4",
    },
};

const oneDark: Theme = {
    id: "one-dark",
    name: "One Dark",
    dark: true,
    chrome: {
        bg: "#282c34",
        bgDim: "#21252b",
        bgRaised: "#3a3f4b",
        ink: "#abb2bf",
        inkDim: "#7f848e",
        inkMuted: "#5c6370",
        acc: "#61afef",
        accLine: "rgba(97,175,239,0.30)",
        accDim: "rgba(97,175,239,0.10)",
        line: "#3e4451",
        hl: "rgba(97,175,239,0.06)",
        danger: "#e06c75",
    },
    editor: {
        fg: "#abb2bf",
        bg: "transparent",
        caret: "#61afef",
        selection: "#3e4451",
        activeLine: "rgba(97,175,239,0.06)",
        gutter: "#4b5263",
        gutterActive: "#61afef",
        indent: "#3e4451",
        indentActive: "#5c6370",
    },
    highlight: {
        keyword: "#c678dd",
        string: "#98c379",
        comment: "#5c6370",
        number: "#d19a66",
        function: "#61afef",
        type: "#e5c07b",
        variable: "#abb2bf",
        property: "#e06c75",
        tag: "#e06c75",
        operator: "#56b6c2",
        link: "#98c379",
        invalid: "#e06c75",
        meta: "#5c6370",
        heading: "#61afef",
    },
    terminal: {
        background: "#282c34",
        foreground: "#abb2bf",
        cursor: "#61afef",
        cursorAccent: "#282c34",
        selectionBackground: "#3e4451",
        black: "#282c34",
        red: "#e06c75",
        green: "#98c379",
        yellow: "#e5c07b",
        blue: "#61afef",
        magenta: "#c678dd",
        cyan: "#56b6c2",
        white: "#dcdfe4",
        brightBlack: "#5c6370",
        brightRed: "#e06c75",
        brightGreen: "#98c379",
        brightYellow: "#e5c07b",
        brightBlue: "#61afef",
        brightMagenta: "#c678dd",
        brightCyan: "#56b6c2",
        brightWhite: "#ffffff",
    },
};

const solarizedDark: Theme = {
    id: "solarized-dark",
    name: "Solarized Dark",
    dark: true,
    chrome: {
        bg: "#002b36",
        bgDim: "#001f27",
        bgRaised: "#073642",
        ink: "#eee8d5",
        inkDim: "#93a1a1",
        inkMuted: "#586e75",
        acc: "#268bd2",
        accLine: "rgba(38,139,210,0.30)",
        accDim: "rgba(38,139,210,0.10)",
        line: "#073642",
        hl: "rgba(38,139,210,0.06)",
        danger: "#dc322f",
    },
    editor: {
        fg: "#eee8d5",
        bg: "transparent",
        caret: "#268bd2",
        selection: "#073642",
        activeLine: "rgba(38,139,210,0.06)",
        gutter: "#586e75",
        gutterActive: "#268bd2",
        indent: "#073642",
        indentActive: "#586e75",
    },
    highlight: {
        keyword: "#859900",
        string: "#2aa198",
        comment: "#586e75",
        number: "#d33682",
        function: "#268bd2",
        type: "#b58900",
        variable: "#eee8d5",
        property: "#268bd2",
        tag: "#268bd2",
        operator: "#cb4b16",
        link: "#2aa198",
        invalid: "#dc322f",
        meta: "#586e75",
        heading: "#268bd2",
    },
    terminal: {
        background: "#002b36",
        foreground: "#eee8d5",
        cursor: "#268bd2",
        cursorAccent: "#002b36",
        selectionBackground: "#073642",
        black: "#073642",
        red: "#dc322f",
        green: "#859900",
        yellow: "#b58900",
        blue: "#268bd2",
        magenta: "#d33682",
        cyan: "#2aa198",
        white: "#eee8d5",
        brightBlack: "#586e75",
        brightRed: "#cb4b16",
        brightGreen: "#586e75",
        brightYellow: "#657b83",
        brightBlue: "#839496",
        brightMagenta: "#6c71c4",
        brightCyan: "#93a1a1",
        brightWhite: "#fdf6e3",
    },
};

export const THEMES: Theme[] = [aura, ayuDark, tokyoNight, catppuccin, dracula, gruvboxDark, nord, oneDark, solarizedDark];

export const THEMES_BY_ID: Record<string, Theme> = Object.fromEntries(THEMES.map((t) => [t.id, t]));

export const DEFAULT_THEME_ID = "aura";

export function themeById(id: string): Theme {
    return THEMES_BY_ID[id] ?? THEMES_BY_ID[DEFAULT_THEME_ID];
}

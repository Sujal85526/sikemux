import type { StreamParser } from "@codemirror/language";

const HCL_KEYWORDS = new Set([
    "resource",
    "variable",
    "module",
    "data",
    "output",
    "provider",
    "locals",
    "terraform",
    "backend",
    "provisioner",
    "connection",
    "dynamic",
    "for_each",
    "count",
    "depends_on",
    "lifecycle",
    "true",
    "false",
    "null",
    "for",
    "in",
    "if",
    "else",
    "endif",
    "endfor",
]);

interface HclState {
    block: boolean;
}

export const hcl: StreamParser<HclState> = {
    startState: () => ({ block: false }),
    token(stream, state) {
        if (state.block) {
            if (stream.match(/^.*?\*\//)) state.block = false;
            else stream.skipToEnd();
            return "comment";
        }
        if (stream.eatSpace()) return null;
        if (stream.match(/^#.*/) || stream.match(/^\/\/.*/)) return "comment";
        if (stream.match(/^\/\*/)) {
            if (!stream.match(/^.*?\*\//)) {
                state.block = true;
                stream.skipToEnd();
            }
            return "comment";
        }
        if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return "string";
        if (stream.match(/^<<[-~]?\w+/)) return "string";
        if (stream.match(/^-?\d+(?:\.\d+)?/)) return "number";
        if (stream.match(/^[A-Za-z_][\w-]*/)) {
            return HCL_KEYWORDS.has(stream.current()) ? "keyword" : "variableName";
        }
        if (stream.match(/^[{}[\]()=,.:?]/)) return "punctuation";
        stream.next();
        return null;
    },
};

export const makefile: StreamParser<unknown> = {
    token(stream) {
        if (stream.sol()) {
            if (stream.match(/^\t/)) {
                stream.skipToEnd(); // recipe line
                return null;
            }
            if (stream.match(/^\.[A-Z]+/)) return "keyword"; // .PHONY etc
            if (stream.match(/^[A-Za-z0-9_.\-/% ]+:(?!=)/)) return "keyword"; // target:
            if (stream.match(/^[A-Za-z0-9_]+\s*[:?+]?=/)) return "variableName"; // VAR =
        }
        if (stream.eatSpace()) return null;
        if (stream.match(/^#.*/)) return "comment";
        if (stream.match(/^\$[({][^)}]*[)}]/)) return "variableName"; // $(VAR) ${VAR}
        if (stream.match(/^"(?:[^"\\]|\\.)*"?/) || stream.match(/^'[^']*'?/)) return "string";
        stream.next();
        return null;
    },
};

interface SshConfigState {
    expectDirective: boolean;
}

const SSH_BLOCK_DIRECTIVES = new Set(["host", "match"]);
const SSH_ATOMS = /^(?:yes|no|true|false|ask|auto|none)\b/i;

/** OpenSSH client config: directive-led lines with shell-like values and # comments. */
export const sshConfig: StreamParser<SshConfigState> = {
    startState: () => ({ expectDirective: true }),
    languageData: { commentTokens: { line: "#" } },
    token(stream, state) {
        if (stream.sol()) state.expectDirective = true;
        if (stream.eatSpace()) return null;
        if (stream.match(/^#.*/)) return "comment";

        if (state.expectDirective) {
            state.expectDirective = false;
            if (stream.match(/^[A-Za-z][\w-]*/)) {
                return SSH_BLOCK_DIRECTIVES.has(stream.current().toLowerCase()) ? "keyword" : "propertyName";
            }
        }

        if (stream.match(/^"(?:[^"\\]|\\.)*"?/) || stream.match(/^'(?:[^'\\]|\\.)*'?/)) return "string";
        if (stream.match(/^\$\{[A-Za-z_][A-Za-z0-9_]*\}/) || stream.match(/^%[A-Za-z%]/)) return "variableName";
        if (stream.match(SSH_ATOMS)) return "bool";
        if (stream.match(/^\d+\b/)) return "number";
        if (stream.match(/^[^\s#]+/)) return "string";

        stream.next();
        return null;
    },
};
